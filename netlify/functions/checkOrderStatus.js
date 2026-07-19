const { getAdmin } = require("./_firebaseAdmin");

exports.handler = async (event) => {
  try {
    const admin = getAdmin();
    const db = admin.database();
    const orderId = event.queryStringParameters && event.queryStringParameters.orderId;

    if (!orderId) {
      return { statusCode: 400, body: JSON.stringify({ error: "orderId manquant." }) };
    }

    const snap = await db.ref(`commandes/${orderId}`).once("value");
    const order = snap.val();
    if (!order) {
      return { statusCode: 404, body: JSON.stringify({ error: "Commande introuvable." }) };
    }

    return { statusCode: 200, body: JSON.stringify({ statut: order.statut }) };
  } catch (err) {
    console.error("Erreur checkOrderStatus:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Erreur serveur." }) };
  }
};
