// Minimal idb-keyval helpers (get,set,del,keys) MIT
(function(){
  'use strict';
  function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function createStore(dbName, storeName) {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName);
    };
    const dbp = promisifyRequest(request);
    return (txMode, callback) => dbp.then(db => {
      const tx = db.transaction(storeName, txMode);
      return callback(tx.objectStore(storeName), tx);
    });
  }
  const defaultGetStoreFunc = createStore('recipe-box-db', 'recipes');
  const defaultMetaStoreFunc = createStore('recipe-box-db', 'meta');

  window.idbkv = {
    get(key){return defaultGetStoreFunc('readonly', store => promisifyRequest(store.get(key)));},
    set(key, val){return defaultGetStoreFunc('readwrite', store => (store.put(val, key), promisifyRequest(store.transaction)));},
    del(key){return defaultGetStoreFunc('readwrite', store => (store.delete(key), promisifyRequest(store.transaction)));},
    keys(){return defaultGetStoreFunc('readonly', store => new Promise((resolve, reject)=>{
      const keys = [];
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(keys); return; }
        keys.push(cursor.key);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    }));},
    metaGet(key){return defaultMetaStoreFunc('readonly', store => promisifyRequest(store.get(key)));},
    metaSet(key, val){return defaultMetaStoreFunc('readwrite', store => (store.put(val, key), promisifyRequest(store.transaction)));}
  };
})();
