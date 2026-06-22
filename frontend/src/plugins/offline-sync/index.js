import { syncQueue } from "../../utils/sync.js";
import { getMeta } from "../../utils/offlineStore.js";

export async function mount(store) {
  // Register service worker (PWA shell cache + Web Share Target).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[SW] Registration failed:", err);
    });
  }

  // Handle offline. Treated as unauthenticated if network fails
  try {
    const lastSync = await getMeta("last_sync");
    if (lastSync) {
      store.set("offline_status", { available: true, last_sync: lastSync });
    }
  } catch {
    /* ignore */
  }

  // Sync queue when online
  window.addEventListener("online", syncQueue);
  if (navigator.onLine) syncQueue();
}
