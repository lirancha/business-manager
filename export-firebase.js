const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Initialize Firebase Admin
const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  '/Users/liranreiter/Downloads/zucca-mang-firebase-adminsdk-fbsvc-80b322958e.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Create exports directory
const exportDir = path.join(__dirname, 'exports');
if (!fs.existsSync(exportDir)) {
  fs.mkdirSync(exportDir, { recursive: true });
}

async function exportCollection(collectionPath, filename) {
  console.log(`Exporting ${collectionPath}...`);

  const snapshot = await db.collection(collectionPath).get();
  const data = {};

  snapshot.forEach(doc => {
    data[doc.id] = doc.data();
  });

  const filePath = path.join(exportDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`  -> Saved ${Object.keys(data).length} documents to ${filename}`);

  return data;
}

async function exportDocument(docPath, filename) {
  console.log(`Exporting document ${docPath}...`);

  const doc = await db.doc(docPath).get();

  if (!doc.exists) {
    console.log(`  -> Document not found: ${docPath}`);
    return null;
  }

  const data = { id: doc.id, ...doc.data() };

  const filePath = path.join(exportDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`  -> Saved to ${filename}`);

  return data;
}

async function exportAllSubcollections(parentPath, collectionName, filename) {
  console.log(`Exporting all documents from ${parentPath}/${collectionName}...`);

  // First get all documents in the parent collection
  const parentSnapshot = await db.collection(parentPath).get();
  const allData = {};

  for (const parentDoc of parentSnapshot.docs) {
    allData[parentDoc.id] = parentDoc.data();
  }

  const filePath = path.join(exportDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(allData, null, 2));
  console.log(`  -> Saved ${Object.keys(allData).length} documents to ${filename}`);

  return allData;
}

async function main() {
  console.log('='.repeat(50));
  console.log('Firebase Export Script');
  console.log('='.repeat(50));
  console.log('');

  try {
    // Export locations (isgav and frankfurt)
    await exportDocument('locations/isgav', 'location-isgav.json');
    await exportDocument('locations/frankfurt', 'location-frankfurt.json');

    // Export employee-schedules collection (includes config and weekly schedules)
    await exportAllSubcollections('employee-schedules', '', 'employee-schedules.json');

    // Export reminders collection
    await exportCollection('reminders', 'reminders.json');

    // Export backups collection
    await exportCollection('backups', 'backups.json');

    console.log('');
    console.log('='.repeat(50));
    console.log('Export complete!');
    console.log(`Files saved to: ${exportDir}`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('Export failed:', error);
    process.exit(1);
  }

  process.exit(0);
}

main();
