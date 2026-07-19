const { getAdmin } = require("./_firebaseAdmin");

exports.handler = async (event) => {
  try {
    const admin = getAdmin();
    const db = admin.database();
    const data = JSON.parse(event.body || "{}");
    const orderId = data.metadata && data.metadata.order_id;

    if (!orderId) {
      console.warn("Webhook OpenPay reçu sans order_id", data);
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    const orderRef = db.ref(`commandes/${orderId}`);
    const snap = await orderRef.once("value");
    const order = snap.val();

    if (!order) {
      console.warn("Webhook OpenPay pour commande introuvable", orderId);
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    const dejaTraite = ["en_attente_livraison", "livré", "echec_paiement"].includes(order.statut);

    if (!dejaTraite) {
      if (data.status === "success") {
        if (order.produit && order.produit.id) {
          await db.ref(`produits/${order.produit.id}/stock`).transaction((stock) => Math.max(0, (stock || 0) - 1));
        }
        await orderRef.update({ statut: "en_attente_livraison", paidAt: Date.now() });
      } else if (data.status === "failed" || data.status === "cancelled") {
        await orderRef.update({ statut: "echec_paiement" });
      }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error("Erreur webhookOpenpay:", err);
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }
};
