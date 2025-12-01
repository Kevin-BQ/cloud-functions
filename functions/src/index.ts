import * as admin from "firebase-admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { MulticastMessage } from "firebase-admin/messaging";

admin.initializeApp();

// =============================
// INTERFAZ Y HELPERS
// =============================
interface Notification {
  type: string;
  args?: string[];
  targetRoute?: string;
  targetId?: string;
  id?: string;
}

// =================================================================
// FUNCIÓN 1: Detecta un nuevo LIKE y crea el documento de notificación
// =================================================================
export const createNotificationOnNewLike = onDocumentCreated(
  {
    document: "blogs/{blogId}/reaction/{userId}",
    region: "southamerica-east1",
  },
  async (event) => {
    logger.log("🔔 INICIO: createNotificationOnNewLike");
    const snap = event.data;
    if (!snap) return logger.log("❌ No hay datos de reacción.");

    const blogId = event.params.blogId;
    const likerId = event.params.userId;

    const blogDoc = await admin.firestore().collection("blogs").doc(blogId).get();
    if (!blogDoc.exists) return logger.error(`❌ Blog no existe: ${blogId}`);

    const blogData = blogDoc.data()!;
    const authorId = blogData.author?.uid;
    if (!authorId) return logger.error("❌ Blog sin author.uid");
    if (authorId === likerId) return logger.log("⚠️ Autor se dio like a sí mismo.");

    const likerDoc = await admin.firestore().collection("users").doc(likerId).get();
    const likerName = likerDoc.exists ? likerDoc.data()!.fullName : "Alguien";
    const blogTitle = blogData.title ?? "tu publicación";

    // El documento de Firestore solo contiene los DATOS, no el texto de la UI.
    await admin.firestore().collection("users").doc(authorId).collection("notifications").add({
        type: "LIKE",
        args: [likerName, blogTitle], // La app usará esto para construir el texto.
        targetRoute: `blog_post_detail/${blogId}`,
        targetId: blogId,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "NEW",
      });

    logger.log(`✅ Notificación LIKE creada para ${authorId}`);
  }
);

// =================================================================
// FUNCIÓN 2: Detecta un nuevo COMENTARIO y crea la notificación
// =================================================================
export const createNotificationOnNewComment = onDocumentCreated(
  {
    document: "blogs/{blogId}/comments/{commentId}",
    region: "southamerica-east1",
  },
  async (event) => {
    logger.log("🔔 INICIO: createNotificationOnNewComment");
    const snap = event.data;
    if (!snap) return logger.log("❌ No hay datos de comentario.");

    const comment = snap.data();
    const blogId = event.params.blogId;
    if (!comment?.author?.uid) return logger.error("❌ Comentario sin author.uid");

    const commenterId = comment.author.uid;
    const commentText = comment.content ?? "";

    const blogDoc = await admin.firestore().collection("blogs").doc(blogId).get();
    if (!blogDoc.exists) return logger.error(`❌ Blog no existe: ${blogId}`);

    const blogData = blogDoc.data()!;
    const authorId = blogData.author?.uid;
    if (!authorId) return logger.error("❌ Blog sin author.uid");
    if (authorId === commenterId) return logger.log("⚠️ Autor comentó en su propio post.");

    const commenterName = comment.author.fullName ?? "Alguien";
    
    await admin.firestore().collection("users").doc(authorId).collection("notifications").add({
        type: "COMMENT",
        args: [commenterName, commentText],
        targetRoute: `blog_post_detail/${blogId}`,
        targetId: blogId,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "NEW",
      });

    logger.log(`✅ Notificación COMMENT creada para ${authorId}`);
  }
);


// =======================================================================
// FUNCIÓN 3: Envía PUSH de solo-datos cuando aparece una notificación
// =======================================================================
export const sendPushOnNewNotification = onDocumentCreated(
  {
    document: "users/{userId}/notifications/{notificationId}",
    region: "southamerica-east1",
  },
  async (event) => {
    logger.log("📲 INICIO: sendPushOnNewNotification");
    const snap = event.data;
    if (!snap) return logger.log("❌ Sin data.");

    const notification = snap.data() as Notification;
    const userId = event.params.userId;
    const notificationId = snap.id;

    const tokensSnapshot = await admin.firestore().collection("users").doc(userId).collection("deviceTokens").get();
    if (tokensSnapshot.empty) return logger.log(`⚠️ Usuario sin tokens: ${userId}`);

    const tokens = tokensSnapshot.docs.map((doc) => doc.data().token);
    logger.log(`📱 Tokens encontrados: ${tokens.length}`);
    
    // --- CORRECCIÓN FINAL ---
    // Construir un payload de SOLO-DATOS.
    // La app se encargará de crear el título y el cuerpo.
    const dataPayload: { [key: string]: string } = {
      type: notification.type ?? "UNKNOWN",
      notificationId: notificationId,
      targetRoute: notification.targetRoute ?? "",
      targetId: notification.targetId ?? "",
    };

    // Añadir los argumentos de forma individual (arg0, arg1, etc.)
    notification.args?.forEach((arg, index) => {
      dataPayload[`arg${index}`] = arg;
    });

    logger.log("📦 Payload de datos a enviar:", dataPayload);

    const message: MulticastMessage = {
      data: dataPayload, // <-- SOLO se usa el campo 'data'
      tokens,
    };

    try {
      const response = await admin.messaging().sendEachForMulticast(message);
      logger.log(`✅ Push de datos enviado. Éxitos: ${response.successCount}, Fallos: ${response.failureCount}`);
      
      const tokensToDelete: string[] = [];

      response.responses.forEach((res, idx) => {
        if (!res.success && res.error) {
          const errorCode = res.error.code;

          if (
            errorCode === "messaging/invalid-registration-token" ||
            errorCode === "messaging/registration-token-not-registered"
          ) {
            tokensToDelete.push(tokens[idx]);
            logger.log(`⚠️ Token inválido detectado: ${tokens[idx].substring(0, 20)}...`);
          }
        }
      });

      // Eliminar tokens inválidos usando batch
      if (tokensToDelete.length > 0) {
        const batch = admin.firestore().batch();

        for (const badToken of tokensToDelete) {
          const tokenDocs = await admin
            .firestore()
            .collection("users")
            .doc(userId)
            .collection("deviceTokens")
            .where("token", "==", badToken)
            .get();

          tokenDocs.docs.forEach((doc) => {
            batch.delete(doc.ref);
          });
        }

        await batch.commit();
        logger.log(`🧹 Tokens inválidos eliminados: ${tokensToDelete.length}`);
      }

    } catch (error) {
      logger.error("❌ Error enviando push de datos:", error);
    }
  }
);