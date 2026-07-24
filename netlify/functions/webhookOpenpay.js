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
        const items = order.items || (order.produit ? [{ ...order.produit, qte: 1 }] : []);
        for (const it of items) {
          if (it && it.id) {
            await db.ref(`produits/${it.id}/stock`).transaction((stock) => Math.max(0, (stock || 0) - (it.qte || 1)));
          }
        }
        await orderRef.update({ statut: "en_attente_livraison", paidAt: Date.now() });
      } else if (data.status === "failed" || data.status === "cancelled") {
        await orderRef.update({ statut: "echec_paiement" });
      }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error("Erreur webhookOpenpay:", err);
    // On répond quand même 200 pour éviter des relances infinies
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }
};
