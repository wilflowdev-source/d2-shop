const { getAdmin } = require("./_firebaseAdmin");

const OPENPAY_URL = "https://api.openpay-cg.com/v1/transaction/payment";
const PROVIDERS_VALIDES = ["MTN", "AIRTEL"];
const MAX_ARTICLES = 30; // garde-fou anti-abus

function nettoyerTelephone(tel) {
  return String(tel || "").replace(/\D/g, "");
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
      const prix = Number(prod.prix);
      montant += prix * it.qte;
      itemsValides.push({ id: it.id, nom: prod.nom, prix, taille: it.taille || null, qte: it.qte });
    }

    if (montant <= 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "Montant de commande invalide." }) };
    }

    // 1. Créer la commande
    const orderRef = db.ref("commandes").push();
    const orderId = orderRef.key;
    await orderRef.set({
      items: itemsValides,
      client: { nom: client.nom, prenom: client.prenom, adresse: client.adresse, telephone, provider },
      montant,
      statut: "en_attente_paiement",
      createdAt: Date.now(),
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
