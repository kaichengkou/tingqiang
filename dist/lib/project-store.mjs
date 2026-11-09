const DB_NAME = 'tingqiang-practice-v1';
let opening, persistence;
// Pitch analyses live in their own records (v2), so routine position and setting saves stay small.
const storedAnalysis = ({energy, beats, ...analysis}) => analysis;
const projectRecord = ({analysis, takes = [], ...project}) => ({...project, takes: takes.map(({analysis, ...take}) => take)});
/** Analyses held by a project, keyed like its assets: 'reference' and 'take:<id>'. */
export function projectAnalyses(project) {
  return [['reference', project.analysis], ...(project.takes || []).map(take => [`take:${take.id}`, take.analysis])]
    .filter(([, analysis]) => analysis).map(([kind, analysis]) => ({kind, analysis}));
}
function database() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('当前浏览器不支持本机保存。'));
  return opening ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = event => {
      const db = request.result;
      if (event.oldVersion < 1) {
        db.createObjectStore('projects', {keyPath: 'id'});
        db.createObjectStore('shelf', {keyPath: 'id'});
        const assets = db.createObjectStore('assets', {keyPath: ['project', 'kind']});
        assets.createIndex('project', 'project');
      }
      if (event.oldVersion < 2) {
        const analyses = db.createObjectStore('analyses', {keyPath: ['project', 'kind']});
        analyses.createIndex('project', 'project');
        // v1 kept analyses inside each project record; move them out once.
        request.transaction.objectStore('projects').openCursor().onsuccess = ({target}) => {
          const cursor = target.result; if (!cursor) return;
          for (const {kind, analysis} of projectAnalyses(cursor.value)) analyses.put({project: cursor.value.id, kind, analysis: storedAnalysis(analysis)});
          cursor.update(projectRecord(cursor.value)); cursor.continue();
        };
      }
    };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => { opening = null; reject(request.error); };
    request.onblocked = () => { opening = null; reject(new Error('请关闭其他听腔页面后重试保存。')); };
  });
}
const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('保存已中断')); });
const result = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });

/** Writes the project state plus only the assets and analyses that changed. */
export async function saveProject(project, {assets = [], analyses = [], removed = []} = {}) {
  // Ask once, at the first thing worth keeping, so low disk space can't silently evict recordings.
  persistence ||= navigator.storage?.persist?.().catch(() => {}) || true;
  const db = await database(), tx = db.transaction(['projects', 'shelf', 'assets', 'analyses'], 'readwrite'), completion = done(tx);
  tx.objectStore('projects').put(projectRecord(project));
  tx.objectStore('shelf').put({id: project.id, title: project.title, duration: project.duration, position: project.position, updatedAt: project.updatedAt, hasVocals: project.hasVocals, takes: project.takes?.length || 0});
  for (const asset of assets) tx.objectStore('assets').put({project: project.id, kind: asset.kind, blob: asset.blob});
  for (const {kind, analysis} of analyses) tx.objectStore('analyses').put({project: project.id, kind, analysis: storedAnalysis(analysis)});
  for (const kind of removed) { tx.objectStore('assets').delete([project.id, kind]); tx.objectStore('analyses').delete([project.id, kind]); }
  await completion;
}
export async function listProjects() {
  const db = await database(), tx = db.transaction('shelf');
  return (await result(tx.objectStore('shelf').getAll())).sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function readProject(id) {
  const db = await database(), tx = db.transaction(['projects', 'analyses']);
  const [project, analyses] = await Promise.all([result(tx.objectStore('projects').get(id)), result(tx.objectStore('analyses').index('project').getAll(id))]);
  if (!project) return project;
  const stored = new Map(analyses.map(item => [item.kind, item.analysis]));
  return {...project, analysis: stored.get('reference') || null, takes: (project.takes || []).map(take => ({...take, analysis: stored.get(`take:${take.id}`) || null}))};
}
export async function readAsset(id, kind) {
  const db = await database();
  return (await result(db.transaction('assets').objectStore('assets').get([id, kind])))?.blob;
}
export async function allAssets(id) {
  const db = await database();
  return result(db.transaction('assets').objectStore('assets').index('project').getAll(id));
}
export async function deleteProject(id) {
  const db = await database(), tx = db.transaction(['projects', 'shelf', 'assets', 'analyses'], 'readwrite'), completion = done(tx);
  tx.objectStore('projects').delete(id); tx.objectStore('shelf').delete(id);
  for (const name of ['assets', 'analyses']) {
    const request = tx.objectStore(name).index('project').openKeyCursor(IDBKeyRange.only(id));
    request.onsuccess = () => { const cursor = request.result; if (cursor) { tx.objectStore(name).delete(cursor.primaryKey); cursor.continue(); } };
  }
  await completion;
}
