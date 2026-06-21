import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import firebaseConfig from './firebase-applet-config.json' assert { type: "json" };

async function fixUsersAndAllowed() {
    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

    const checkCollection = async (collName: string) => {
        console.log(`Checking ${collName}...`);
        const snap = await getDocs(collection(db, collName));
        for (const d of snap.docs) {
            const data = d.data();
            let needsUpdate = false;
            let updateData: any = {};
            
            if (data.banned === true) {
                updateData.banned = false;
                needsUpdate = true;
                console.log(`- Found banned flag: ${collName}/${d.id} (${data.fullName || data.name})`);
            }
            if (data.ips && data.ips.length > 3) {
                console.log(`- Found ips > 3: ${collName}/${d.id} (${data.fullName || data.name}). Clearing ips.`);
                // Keep the current IP or empty list? We will keep empty list.
                updateData.ips = [];
                needsUpdate = true;
            }

            if (needsUpdate) {
                await updateDoc(doc(db, collName, d.id), updateData);
                console.log(`  Updated ${d.id}`);
            }
        }
    };

    await checkCollection('users');
    await checkCollection('allowed_students');
    console.log('Done.');
    process.exit(0);
}

fixUsersAndAllowed().catch(console.error);
