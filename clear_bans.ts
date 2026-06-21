import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, setDoc, query, where, updateDoc } from 'firebase/firestore';
import firebaseConfig from './firebase-applet-config.json' assert { type: "json" };

async function clearBans() {
    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

    const strikesSnap = await getDocs(collection(db, 'strikes'));
    let count = 0;
    for (const d of strikesSnap.docs) {
        const data = d.data();
        if (data.banned === true) {
            console.log(`Unbanning ${d.id} (${data.studentName || 'Unknown'})`);
            await updateDoc(doc(db, 'strikes', d.id), { count: 0, banned: false });
            count++;
        }
        console.log(`id: ${d.id}, data: ${JSON.stringify(d.data())}`);
    }
    console.log(`Done. Unbanned ${count} users.`);
    process.exit(0);
}

clearBans().catch(console.error);
