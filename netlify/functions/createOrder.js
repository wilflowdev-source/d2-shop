const { getAdmin } = require("./_firebaseAdmin");

const OPENPAY_URL = "https://api.openpay-cg.com/v1/transaction/payment";
const PROVIDERS_VALIDES = ["MTN", "AIRTEL"];
const MAX_ARTICLES = 30; // garde-fou anti-abus

function nettoyerTelephone(tel) {
  return String(tel || "").replace(/\D/g, "");
}

function sanitizeCode(txt) {
  return String(txt || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "").substring(0, 20);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Méthode non autorisée." }) };
  }

  try {
    const admin = getAdmin();
    const db = admin.database();
    const body = JSON.parse(event.body || "{}");
    const { client } = body;

    // Compatibilité : accepte soit "items" (panier), soit l'ancien "produit" (achat direct)
    let items = body.items;
    if (!items && body.produit && body.produit.id) {
      items = [{ id: body.produit.id, taille: body.produit.taille || null, qte: 1 }];
    }

    if (!Array.isArray(items) || !items.length) {
      return { statusCode: 400, body: JSON.stringify({ error: "Le panier est vide." }) };
    }
    if (items.length > MAX_ARTICLES) {
      return { statusCode: 400, body: JSON.stringify({ error: "Trop d'articles dans la commande." }) };
    }
    for (const it of items) {
      if (!it || !it.id || !Number.isInteger(it.qte) || it.qte < 1) {
        return { statusCode: 400, body: JSON.stringify({ error: "Article de panier invalide." }) };
      }
    }

    if (!client || !client.nom || !client.prenom || !client.adresse || !client.telephone || !client.provider) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Merci de renseigner nom, prénom, adresse, téléphone et opérateur." }),
      };
    }

    const provider = String(client.provider).toUpperCase();
    if (!PROVIDERS_VALIDES.includes(provider)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Opérateur non supporté (MTN ou AIRTEL)." }) };
    }

    const telephone = nettoyerTelephone(client.telephone);
    if (telephone.length < 9) {
      return { statusCode: 400, body: JSON.stringify({ error: "Numéro de téléphone invalide." }) };
    }

    // Vérifier chaque produit et son stock côté serveur (jamais confiance au client)
    // Les promotions actives (par article) sont appliquées ici, jamais au prix envoyé par le navigateur.
    const promosSnap = await db.ref("contenu/promotions").once("value");
    const toutesPromos = promosSnap.val() || {};
    const maintenant = Date.now();
    const reductionParProduit = {};
    Object.values(toutesPromos).forEach((p) => {
      if (!p || !p.produitId || p.actif === false) return;
      if (p.dateFin && p.dateFin < maintenant) return;
      reductionParProduit[p.produitId] = Number(p.reduction) || 0;
    });

    const itemsValides = [];
    let montant = 0;

    for (const it of items) {
      const prodSnap = await db.ref(`produits/${it.id}`).once("value");
      const prod = prodSnap.val();
      if (!prod) {
        return { statusCode: 404, body: JSON.stringify({ error: `Un article de ta commande n'existe plus (${it.id}).` }) };
      }
      if ((prod.stock || 0) < it.qte) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: `Stock insuffisant pour "${prod.nom}" (${prod.stock || 0} disponible(s)).` }),
        };
      }
      const prixCatalogue = Number(prod.prix);
      const reductionArticle = reductionParProduit[it.id] || 0;
      const prixUnitaire = reductionArticle > 0
        ? Math.round(prixCatalogue * (1 - reductionArticle / 100))
        : prixCatalogue;
      montant += prixUnitaire * it.qte;
      itemsValides.push({
        id: it.id,
        nom: prod.nom,
        prix: prixUnitaire,
        prixCatalogue: reductionArticle > 0 ? prixCatalogue : null,
        taille: it.taille || null,
        qte: it.qte,
      });
    }

    if (montant <= 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "Montant de commande invalide." }) };
    }

    // Code d'affiliation / promo (optionnel) : on ne l'attache que s'il correspond à un
    // partenaire actif et non expiré. La réduction client, si définie, est appliquée ici,
    // jamais confiée au montant envoyé par le navigateur.
    let refCode = null;
    let montantAvantReduction = null;
    const codeCandidat = sanitizeCode(body.refCode);
    if (codeCandidat) {
      const affSnap = await db.ref(`contenu/affilies/${codeCandidat}`).once("value");
      const aff = affSnap.val();
      const expire = aff && aff.dateFin && aff.dateFin < Date.now();
      if (aff && aff.actif !== false && !expire) {
        refCode = codeCandidat;
        const reduction = Number(aff.reduction) || 0;
        if (reduction > 0) {
          montantAvantReduction = montant;
          montant = Math.round(montant * (1 - reduction / 100));
        }
      }
    }

    // 1. Créer la commande
    const orderRef = db.ref("commandes").push();
    const orderId = orderRef.key;
    await orderRef.set({
      items: itemsValides,
      client: { nom: client.nom, prenom: client.prenom, adresse: client.adresse, telephone, provider },
      montant,
      montantAvantReduction,
      statut: "en_attente_paiement",
      createdAt: Date.now(),
      refCode,
    });

    // 2. Initier le paiement OpenPay
    const openpayRes = await fetch(OPENPAY_URL, {
      method: "POST",
      headers: {
        "XO-API-KEY": process.env.OPENPAY_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        amount: montant,
        payment_phone_number: telephone,
        provider,
        customer: { name: `${client.prenom} ${client.nom}`, phone: telephone },
        customer_external_id: telephone,
        metadata: { order_id: orderId },
      }),
    });

    const data = await openpayRes.json();

    if (!openpayRes.ok || data.status === "error" || data.error) {
      await orderRef.update({
        statut: "erreur_paiement",
        openpayErreur: data.error || data.message || "Erreur inconnue",
      });
      return {
        statusCode: 400,
        body: JSON.stringify({ error: data.error || data.message || "Le paiement n'a pas pu être initié." }),
      };
    }

    await orderRef.update({ statut: "paiement_en_cours", openpayReference: data.reference || null });

    return {
      statusCode: 200,
      body: JSON.stringify({
        orderId,
        reference: data.reference,
        status: data.status,
        message: data.message || "Vérifiez votre téléphone pour confirmer le paiement mobile money.",
      }),
    };
  } catch (err) {
    console.error("Erreur createOrder:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Erreur serveur. Réessaye dans un instant." }) };
  }
};
