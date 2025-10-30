import { Client, Databases, Storage, Query } from 'node-appwrite';

export default async function deleteEvent(context) {
  context.log('🔹 Starting event deletion function...');

  let payload = {};
  try {
    if (context.req.bodyRaw) payload = JSON.parse(context.req.bodyRaw);
  } catch (err) {
    context.error('❌ Invalid JSON in request body: ' + err.message);
    return context.res.json({ statusCode: 400, error: 'Invalid JSON in request body' });
  }

  const { eventId } = payload;
  if (!eventId) {
    context.error('❌ Missing eventId in request body');
    return context.res.json({ statusCode: 400, error: 'Missing eventId' });
  }

  // 0️⃣ Ensure the user is authenticated
  if (!context.userId) {
    context.error('❌ Unauthorized request – no userId found in context');
    return context.res.json({ statusCode: 401, error: 'Unauthorized – user not logged in' });
  }

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);
  const storage = new Storage(client);

  const databaseId = process.env.APPWRITE_DATABASE_ID;
  const photoCollectionId = process.env.APPWRITE_PHOTO_COLLECTION_ID;
  const eventCollectionId = process.env.APPWRITE_EVENT_COLLECTION_ID;
  const bucketId = process.env.APPWRITE_BUCKET_ID;

  const currentUserId = String(context.userId);

  try {
    // 1️⃣ Fetch event document
    const eventDoc = await databases.getDocument(databaseId, eventCollectionId, eventId);
    if (!eventDoc) {
      return context.res.json({ statusCode: 404, error: 'Event not found' });
    }

    // 2️⃣ Verify ownership using user_id field
    const eventUserId = String(eventDoc.user_id || '').trim();
    if (eventUserId !== currentUserId) {
      context.error(`❌ Ownership mismatch: event.user_id=${eventUserId}, user=${currentUserId}`);
      return context.res.json({
        statusCode: 403,
        error: 'Forbidden – you do not own this event',
      });
    }

    context.log(`🔒 Ownership verified for user ${currentUserId}`);

    // 3️⃣ Fetch all photos for this event with pagination
    const limit = 100;
    let offset = 0;
    let allPhotos = [];

    context.log(`🔹 Fetching photos for event ${eventId} in pages of ${limit}...`);
    while (true) {
      const response = await databases.listDocuments(databaseId, photoCollectionId, [
        Query.equal('event_id', eventId),
        Query.limit(limit),
        Query.offset(offset),
      ]);

      if (response.documents.length === 0) break;
      allPhotos.push(...response.documents);
      offset += response.documents.length;
      if (response.documents.length < limit) break;
    }

    context.log(`📸 Total photos to delete: ${allPhotos.length}`);

    // 4️⃣ Delete photos (storage + docs) in parallel chunks
    const chunkSize = 20;
    for (let i = 0; i < allPhotos.length; i += chunkSize) {
      const chunk = allPhotos.slice(i, i + chunkSize);
      await Promise.allSettled(
        chunk.map(async (photo) => {
          if (photo.file_id) {
            try {
              await storage.deleteFile(bucketId, photo.file_id);
              context.log(`🗑️ Deleted file ${photo.file_id}`);
            } catch (err) {
              context.error(`⚠️ Could not delete file ${photo.file_id}: ${err.message}`);
            }
          }
          try {
            await databases.deleteDocument(databaseId, photoCollectionId, photo.$id);
            context.log(`🗑️ Deleted photo ${photo.$id}`);
          } catch (err) {
            context.error(`⚠️ Could not delete photo doc ${photo.$id}: ${err.message}`);
          }
        })
      );
    }

    // 5️⃣ Delete the event itself
    await databases.deleteDocument(databaseId, eventCollectionId, eventId);
    context.log(`🗑️ Deleted event ${eventId}`);

    return context.res.json({
      statusCode: 200,
      message: 'Event and all associated photos deleted successfully',
      eventId,
      deletedPhotos: allPhotos.length,
    });
  } catch (error) {
    context.error('❌ Error deleting event: ' + error.message);
    context.error(error.stack);
    return context.res.json({ statusCode: 500, error: error.message });
  }
}
