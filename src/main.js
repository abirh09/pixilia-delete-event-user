import { Client, Databases, Storage, Query } from 'node-appwrite';

export default async function deleteEvent(context) {
  context.log('🔹 Starting event deletion function...');

  let payload = {};
  try {
    context.log('📥 Parsing request body...');
    if (context.req.bodyRaw) {
      payload = JSON.parse(context.req.bodyRaw);
      context.log('✅ Request body parsed:', payload);
    }
  } catch (err) {
    context.error('❌ Invalid JSON in request body: ' + err.message);
    return context.res.json({ statusCode: 400, error: 'Invalid JSON in request body' });
  }

  const { eventId } = payload;
  if (!eventId) {
    context.error('❌ Missing eventId in request body');
    return context.res.json({ statusCode: 400, error: 'Missing eventId' });
  }
  context.log(`📌 Event ID received: ${eventId}`);

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);
  context.log('🔗 Appwrite client initialized');

  const databases = new Databases(client);
  const storage = new Storage(client);

  const databaseId = process.env.APPWRITE_DATABASE_ID;
  const photoCollectionId = process.env.APPWRITE_PHOTO_COLLECTION_ID;
  const eventCollectionId = process.env.APPWRITE_EVENT_COLLECTION_ID;
  const bucketId = process.env.APPWRITE_BUCKET_ID;

  const headers = context.req.headers;
  const currentUserId = headers['x-appwrite-user-id'];
  context.log(`👤 Current user ID from headers: ${currentUserId}`);

  try {
    // 1️⃣ Get the event document
    context.log(`🔹 Fetching event document ${eventId}...`);
    const eventDoc = await databases.getDocument(databaseId, eventCollectionId, eventId);
    if (!eventDoc) {
      context.log('⚠️ Event document not found');
      return context.res.json({ statusCode: 404, error: 'Event not found' });
    }
    context.log('✅ Event document fetched:', eventDoc);

    // 2️⃣ Verify ownership using user_id field
    const eventUserId = String(eventDoc.user_id || '').trim();
    context.log(`🔑 Event owner: ${eventUserId}`);
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
      context.log(`📄 Fetching photos offset=${offset}...`);
      const response = await databases.listDocuments(databaseId, photoCollectionId, [
        Query.equal('event_id', eventId),
        Query.limit(limit),
        Query.offset(offset),
      ]);

      context.log(`📄 Fetched ${response.documents.length} photos`);
      if (response.documents.length === 0) break;

      allPhotos.push(...response.documents);
      offset += response.documents.length;

      if (response.documents.length < limit) break;
    }

    context.log(`📸 Total photos to delete: ${allPhotos.length}`);

    // 4️⃣ Delete photos in parallel (both storage file and document)
    const chunkSize = 20;
    const photoChunks = [];
    for (let i = 0; i < allPhotos.length; i += chunkSize) {
      photoChunks.push(allPhotos.slice(i, i + chunkSize));
    }
    context.log(`🔹 Deleting photos in ${photoChunks.length} chunks of up to ${chunkSize} each...`);

    for (const [index, chunk] of photoChunks.entries()) {
      context.log(`🔹 Processing chunk ${index + 1}/${photoChunks.length}`);
      await Promise.allSettled(
        chunk.map(async (photo) => {
          // Delete storage file
          if (photo.file_id) {
            try {
              await storage.deleteFile(bucketId, photo.file_id);
              context.log(`🗑️ Deleted file ${photo.file_id}`);
            } catch (err) {
              context.error(`⚠️ Failed to delete file ${photo.file_id}: ${err.message}`);
            }
          }
          // Delete photo document
          try {
            await databases.deleteDocument(databaseId, photoCollectionId, photo.$id);
            context.log(`🗑️ Deleted photo document ${photo.$id}`);
          } catch (err) {
            context.error(`⚠️ Failed to delete photo document ${photo.$id}: ${err.message}`);
          }
        })
      );
    }

    // 5️⃣ Delete the event document
    context.log(`🔹 Deleting event document ${eventId}...`);
    await databases.deleteDocument(databaseId, eventCollectionId, eventId);
    context.log(`🗑️ Deleted event document ${eventId}`);

    context.log('✅ Event deletion process completed successfully');
    return context.res.json({
      statusCode: 200,
      message: 'Event and all associated photos deleted successfully',
      eventId,
      deletedPhotos: allPhotos.length,
    });
  } catch (error) {
    context.error('❌ Error deleting event: ' + error.message);
    return context.res.json({ statusCode: 500, error: error.message });
  }
}
