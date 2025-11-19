import * as admin from "firebase-admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { MulticastMessage } from "firebase-admin/messaging";

admin.initializeApp();

// =============================
// INTERFAZ DE NOTIFICACIÓN
// =============================
interface Notification {
  type: string;
  args?: string[];
  targetRoute?: string;
  targetId?: string;
  id?: string;
}

// =================================================================
// FUNCIÓN 1: Detecta un nuevo LIKE y crea la notificación
// =================================================================
export const createNotificationOnNewLike = onDocumentCreated(
  {
    document: "blogs/{blogId}/reaction/{userId}",
    region: "southamerica-east1",
  },
  async (event) => {
    logger.log("🔔 INICIO: createNotificationOnNewLike disparada");

    const snap = event.data;
    if (!snap) {
      logger.log("❌ No hay datos de reacción, omitiendo.");
      return;
    }

    const blogId = event.params.blogId;
    const likerId: string = event.params.userId;

    logger.log(`📝 Parámetros: blogId=${blogId}, likerId=${likerId}`);

    const blogDoc = await admin.firestore().collection("blogs").doc(blogId).get();
    if (!blogDoc.exists) {
      logger.error(`❌ El blog no existe: ${blogId}`);
      return;
    }

    const blogData = blogDoc.data()!;
    logger.log(`📄 Blog encontrado:`, JSON.stringify(blogData));

    const authorId = blogData.author?.uid;

    if (!authorId) {
      logger.error("❌ El blog no tiene author.uid definido");
      return;
    }

    logger.log(`👤 Author ID: ${authorId}`);

    if (authorId === likerId) {
      logger.log("⚠️ Autor se dio like a sí mismo, no notificar.");
      return;
    }

    const blogTitle = blogData.title ?? "tu publicación";

    const likerDoc = await admin.firestore().collection("users").doc(likerId).get();
    const likerName = likerDoc.exists ? likerDoc.data()!.fullName : "Alguien";

    logger.log(`👍 Liker: ${likerName} (${likerId})`);

    await admin
      .firestore()
      .collection("users")
      .doc(authorId)
      .collection("notifications")
      .add({
        type: "LIKE",
        args: [likerName, blogTitle],
        targetRoute: `blog_post_detail/${blogId}`,
        targetId: blogId,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "NEW",
      });

    logger.log(`✅ Notificación LIKE creada para ${authorId} por ${likerId}`);
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
    const snap = event.data;
    if (!snap) return logger.log("No hay datos de comentario, omitiendo.");

    const comment = snap.data();
    const blogId = event.params.blogId;

    if (!comment?.author?.uid) {
      return logger.error("comment.author.uid es inválido");
    }

    const commenterId: string = comment.author.uid;
    const commentText: string = comment.text ?? "";

    const blogDoc = await admin.firestore().collection("blogs").doc(blogId).get();
    if (!blogDoc.exists) {
      return logger.error("Blog no encontrado:", blogId);
    }

    const blogData = blogDoc.data()!;
    const authorId = blogData.author?.uid;

    if (!authorId) {
      return logger.error("El blog no tiene author.uid");
    }

    if (authorId === commenterId) {
      return logger.log("Autor comentó en su propio post, no notificar.");
    }

    const commenterName = comment.author.fullName ?? "Alguien";

    await admin
      .firestore()
      .collection("users")
      .doc(authorId)
      .collection("notifications")
      .add({
        type: "COMMENT",
        args: [commenterName, commentText],
        targetRoute: `blog_post_detail/${blogId}`,
        targetId: blogId,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "NEW",
      });

    logger.log(`Notificación COMMENT creada para ${authorId} por ${commenterId}`);
  }
);

// =======================================================================
// FUNCIÓN 3: Envía PUSH cuando aparece una nueva notificación
// =======================================================================
export const sendPushOnNewNotification = onDocumentCreated(
  {
    document: "users/{userId}/notifications/{notificationId}",
    region: "southamerica-east1",
  },
  async (event) => {
    logger.log("📲 INICIO: sendPushOnNewNotification disparada");

    const snap = event.data;
    if (!snap) {
      logger.log("❌ Sin data, omitiendo.");
      return;
    }

    const notification = snap.data() as Notification;
    const userId = event.params.userId;
    const notificationId = snap.id;

    logger.log(`📝 Notificación creada para userId: ${userId}, tipo: ${notification.type}`);

    const tokensSnapshot = await admin
      .firestore()
      .collection("users")
      .doc(userId)
      .collection("deviceTokens")
      .get();

    if (tokensSnapshot.empty) {
      logger.log(`⚠️ Usuario sin tokens: ${userId}`);
      return;
    }

    const tokens = tokensSnapshot.docs.map((doc) => doc.data().token);
    logger.log(`📱 Tokens encontrados: ${tokens.length}`);

    const title = buildTitle(notification);
    const body = buildBody(notification);

    logger.log(`📧 Mensaje - Título: "${title}", Cuerpo: "${body}"`);

    const message: MulticastMessage = {
      notification: { title, body },
      data: {
        targetRoute: notification.targetRoute ?? "",
        targetId: notification.targetId ?? "",
        type: notification.type ?? "",
        notificationId,
      },
      tokens,
    };

    try {
      // ✅ Usar sendEachForMulticast en lugar de sendMulticast
      // para evitar el error 404 /batch en regiones fuera de us-central1
      const response = await admin.messaging().sendEachForMulticast(message);

      const successCount = response.responses.filter((r) => r.success).length;
      const failureCount = response.responses.filter((r) => !r.success).length;

      logger.log(
        `✅ Push enviado a ${tokens.length} dispositivos. ` +
        `Éxitos: ${successCount}, Fallos: ${failureCount}`
      );

      // Limpieza de tokens inválidos
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
      logger.error("❌ Error enviando push:", error);
    }
  }
);

// =================================================================
// HELPERS
// =================================================================
function buildTitle(notification: Notification): string {
  switch (notification.type) {
    case "LIKE":
      return `${notification.args?.[0] ?? "Alguien"} le dio like a tu publicación`;
    case "COMMENT":
      return `${notification.args?.[0] ?? "Alguien"} comentó en tu publicación`;
    default:
      return "Tienes una nueva notificación";
  }
}

function buildBody(notification: Notification): string {
  switch (notification.type) {
    case "LIKE":
      return `Publicación: ${notification.args?.[1] ?? ""}`;
    case "COMMENT":
      return notification.args?.[1] ?? "";
    default:
      return "";
  }
}
