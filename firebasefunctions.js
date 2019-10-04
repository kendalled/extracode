//Import firebase functions
const functions = require('firebase-functions');
// Config Stripe.js

const currency = functions.config().stripe.currency || 'USD';
// Firestore
var db = require("firebase/firestore");
// Admin Privs & Init
var admin = require('firebase-admin');
var app = admin.initializeApp();

// Cloud Functions Code
// CreateUser Triggered on Creation
// When a user is created, register them with Stripe
exports.createStripeCustomer = functions.auth.user().onCreate(async (user) => {
    const customer = await stripe.customers.create({ email: user.email });
    return admin.firestore().collection('stripe_customers').doc(user.uid).set({ customer_id: customer.id });
});

exports.needStripeAccount = functions.https.onCall(async (userName, userEmail ) => {
  // let shipping = userAddress
  // const shippingData = {
  //   'address': {
  //     'line1': this.shipping[0],
  //     'line2': this.shipping[1],
  //     'city': this.shipping[2],
  //     'state': this.shipping[3],
  //     'country': 'US'
  //   },
  //   'name': userName
  // }
  const idempotencyKey = userEmail;
  const customer = await stripe.customers.create({ name: userName, email: userEmail }, { idempotency_key: idempotencyKey });
  return admin.firestore().collection('stripe_customers').doc(customer_id).set({ customer_id: customer.id });
});
// CleanupUser Synchronizes Stripe and Firestore Customers
// When a user deletes their account, clean up after them
exports.cleanupUser = functions.auth.user().onDelete(async (user) => {
    const snapshot = await admin.firestore().collection('stripe_customers').doc(user.uid).get();
    const customer = snapshot.data();
    await stripe.customers.del(customer.customer_id);
    return admin.firestore().collection('stripe_customers').doc(user.uid).delete();
});

// Add a payment source (card) for a user by writing a stripe payment source token to Realtime database
exports.addPaymentSource = functions.firestore.document('/stripe_customers/{userId}/tokens/{pushId}').onCreate(async (snap, context) => {
    const source = snap.data();
    const token = source.token;
    if (source === null) {
        return null;
    }

    try {
        const snapshot = await admin.firestore().collection('stripe_customers').doc(context.params.userId).get();
        const customer = snapshot.data().customer_id;
        const idempotencyKey = context.params.id;
        const response = await stripe.customers.createSource(customer, { source: token, idempotencyKey: idempotencyKey });
        return admin.firestore().collection('stripe_customers').doc(context.params.userId).collection("sources").doc(response.fingerprint).set(response, { merge: true });
    } catch (error) {
        await snap.ref.set({ 'error': userFacingMessage(error) }, { merge: true });
        return reportError(error, { user: context.params.userId });
    }
});

// [START chargecustomer]
// Charge the Stripe customer whenever an amount is written to the Realtime database
exports.createStripeCharge = functions.firestore.document('stripe_customers/{userId}/charges/{id}').onCreate(async (snap, context) => {
    const val = snap.data();
    try {
        // Look up the Stripe customer id written in createStripeCustomer
        const snapshot = await admin.firestore().collection(`stripe_customers`).doc(context.params.userId).get()
        const snapval = snapshot.data();
        const customer = snapval.customer_id
        // Create a charge using the pushId as the idempotency key
        // protecting against double charges
        const amount = val.amount;
        const idempotencyKey = context.params.id;
        const charge = { amount, currency, customer };
        if (val.source !== null) {
            charge.source = val.source;
        }
        const response = await stripe.charges.create(charge, { idempotency_key: idempotencyKey });
        // If the result is successful, write it back to the database
        return snap.ref.set(response, { merge: true });
    } catch (error) {
        // We want to capture errors and render them in a user-friendly way, while
        // still logging an exception with StackDriver
        console.log(error);
        await snap.ref.set({ error: userFacingMessage(error) }, { merge: true });
        return reportError(error, { user: context.params.userId });
    }
});
// [END chargecustomer]]
