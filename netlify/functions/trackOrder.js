const { getAdmin } = require("./_firebaseAdmin");

function nettoyerTelephone(tel) {
  return String(tel || "").replace(/\D/g, "");
}

exports.handler = async (event) => {
  try {
    const admin = getAdmin();
    const db = admin.database();
    const telephone = nettoyerTelephone(event.queryStringParameters && event.queryStringParameters.telephone);

    if (telephone.length < 9) {
      return { statusCode: 400, body: JSON.stringify({ error: "Numéro de téléphone invalide." }) };
    }

    const snap = await db.ref("commandes").once("value");
    const all = snap.val() || {};

    const resultats = Object.entries(all)
      .filter(([, c]) => c.client && nettoyerTelephone(c.client.telephone) === telephone)
      .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0))
      .slice(0, 20)
      .map(([id, c]) => ({
        id,
        statut: c.statut,
        montant: c.montant,
        createdAt: c.createdAt,
        items: c.items || (c.produit ? [{ ...c.produit, qte: 1 }] : []),
      }));

    return { statusCode: 200, body: JSON.stringify({ commandes: resultats }) };
  } catch (err) {
    console.error("Erreur trackOrder:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Erreur serveur." }) };
  }
};
