import webpush from 'web-push';

export async function createPush(store) {
  if (!store.data.vapid?.publicKey || !store.data.vapid?.privateKey) {
    store.data.vapid = webpush.generateVAPIDKeys();
    await store.save();
  }
  const keys = store.data.vapid;
  return {
    publicKey: keys.publicKey,
    async subscribe(deviceId, subscription) {
      const endpoint = subscription?.endpoint;
      if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || !subscription.keys?.p256dh || !subscription.keys?.auth) {
        throw Object.assign(new Error('Некорректная подписка'), { status: 400 });
      }
      store.data.subscriptions = store.data.subscriptions.filter(item => item.endpoint !== endpoint);
      store.data.subscriptions.push({ deviceId, endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } });
      if (store.data.subscriptions.length > 32) store.data.subscriptions.splice(0, store.data.subscriptions.length - 32);
      await store.save();
      return { ok: true };
    },
    async notify(payload) {
      if (!store.data.subscriptions.length) return;
      webpush.setVapidDetails('mailto:pult@localhost', keys.publicKey, keys.privateKey);
      const body = JSON.stringify(payload);
      const topic = String(payload.topic || 'pult').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'pult';
      for (const sub of [...store.data.subscriptions]) {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { TTL: 120, topic, urgency: 'high' });
        } catch (error) {
          if (error.statusCode === 404 || error.statusCode === 410) {
            store.data.subscriptions = store.data.subscriptions.filter(item => item.endpoint !== sub.endpoint);
            await store.save();
          }
        }
      }
    },
  };
}
