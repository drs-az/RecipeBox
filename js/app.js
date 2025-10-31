// Recipe Box PWA logic
const form = document.getElementById('fetchForm');
const urlInput = document.getElementById('recipeUrl');
const statusEl = document.getElementById('status');
const listEl = document.getElementById('recipeList');
const emptyEl = document.getElementById('emptyState');
const detail = document.getElementById('detailView');
const backBtn = document.getElementById('backBtn');
const deleteBtn = document.getElementById('deleteBtn');
const editBtn = document.getElementById('editBtn');
const detailTitle = document.getElementById('detailTitle');
const detailSource = document.getElementById('detailSource');
const detailMeta = document.getElementById('detailMeta');
const detailIngredients = document.getElementById('detailIngredients');
const detailInstructions = document.getElementById('detailInstructions');
const notesWrap = document.getElementById('notesWrap');
const notesEl = document.getElementById('detailNotes');
const saveNotesBtn = document.getElementById('saveNotesBtn');
const editDialog = document.getElementById('editDialog');
const editTitle = document.getElementById('editTitle');
const editIngredients = document.getElementById('editIngredients');
const editInstructions = document.getElementById('editInstructions');
const saveEditBtn = document.getElementById('saveEditBtn');
const searchInput = document.getElementById('searchInput');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importFile = document.getElementById('importFile');
const installBtn = document.getElementById('installBtn');

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.hidden = false;
});
installBtn?.addEventListener('click', async () => {
  installBtn.hidden = true;
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
  }
});

function setStatus(msg, type='info'){
  statusEl.textContent = msg;
  statusEl.style.color = type === 'error' ? '#fca5a5' : '#94a3b8';
}

function normalizeArray(val){
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

function sanitizeText(s){
  return (s||'').toString().trim();
}

function stepsToArray(steps){
  if (!steps) return [];
  if (Array.isArray(steps)){
    return steps.map(s => {
      if (typeof s === 'string') return sanitizeText(s);
      if (s && typeof s === 'object'){
        return sanitizeText(s.text || s.name || '');
      }
      return '';
    }).filter(Boolean);
  }
  return sanitizeText(steps).split(/\n+|\r+|\d+\.|^\s*[-•]\s*/gm).map(s=>s.trim()).filter(Boolean);
}

function ingredientsToArray(ings){
  if (!ings) return [];
  if (Array.isArray(ings)) return ings.map(sanitizeText).filter(Boolean);
  return sanitizeText(ings).split(/\n+|\r+|\s*;\s*/gm).map(s=>s.trim()).filter(Boolean);
}

function domainFromUrl(u){
  try{ return new URL(u).hostname.replace(/^www\./,''); }catch{ return ''; }
}

// Heuristic parse from plain text (Jina Reader)
function parseFromText(text, sourceUrl){
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let title = lines[0] || 'Untitled Recipe';
  // Find headings
  let ingStart = lines.findIndex(l => /^ingredients?\b/i.test(l));
  let instStart = lines.findIndex(l => /^(instructions?|directions?)\b/i.test(l));
  const ingredients = [];
  const steps = [];
  if (ingStart !== -1){
    for (let i = ingStart+1; i < lines.length; i++){
      if (/^(instructions?|directions?)\b/i.test(lines[i])) break;
      if (lines[i].length > 1) ingredients.push(lines[i].replace(/^[-•\d\.\)]\s*/,'').trim());
    }
  }
  if (instStart !== -1){
    for (let i = instStart+1; i < lines.length; i++){
      if (/^(notes?)\b/i.test(lines[i])) break;
      steps.push(lines[i].replace(/^[-•\d\.\)]\s*/,'').trim());
    }
  }
  return {
    id: crypto.randomUUID(),
    url: sourceUrl,
    title,
    ingredients,
    instructions: steps,
    createdAt: Date.now(),
    notes: ''
  };
}

// Extract JSON-LD Recipe objects from HTML
function extractRecipeFromHTML(html, sourceUrl){
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // JSON-LD
  const ldBlocks = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
  for (const script of ldBlocks){
    try {
      const data = JSON.parse(script.textContent.trim());
      const stack = Array.isArray(data) ? data : [data];
      const findRecipe = (node) => {
        if (!node || typeof node !== 'object') return null;
        const typeField = node['@type'];
        const types = normalizeArray(typeField).map(s=>s.toLowerCase());
        if (types.includes('recipe')) return node;
        // Graph or nested
        const inGraph = node['@graph'];
        if (Array.isArray(inGraph)){
          for (const g of inGraph){
            const r = findRecipe(g);
            if (r) return r;
          }
        }
        // Breadcrumb / mainEntity / itemListElement / partOf
        for (const k of ['mainEntity', 'itemListElement', 'partOf', 'articleBody', 'recipe']){
          const v = node[k];
          if (Array.isArray(v)){
            for (const it of v){
              const r = findRecipe(it);
              if (r) return r;
            }
          } else if (v && typeof v === 'object'){
            const r = findRecipe(v);
            if (r) return r;
          }
        }
        return null;
      };
      for (const node of stack){
        const rec = findRecipe(node);
        if (rec){
          const name = sanitizeText(rec.name || doc.querySelector('h1,h2')?.textContent || 'Untitled Recipe');
          const ingredients = ingredientsToArray(rec.recipeIngredient || rec.ingredients);
          let instructions = [];
          if (rec.recipeInstructions){
            if (Array.isArray(rec.recipeInstructions)){
              instructions = rec.recipeInstructions.map(step => {
                if (typeof step === 'string') return sanitizeText(step);
                if (step && typeof step === 'object') return sanitizeText(step.text || step.name);
                return '';
              }).filter(Boolean);
            } else {
              instructions = stepsToArray(rec.recipeInstructions);
            }
          } else {
            // try instructions microdata
            const howTo = doc.querySelectorAll('[itemprop="recipeInstructions"] li, .instructions li, ol li');
            if (howTo.length){
              instructions = Array.from(howTo).map(li=>sanitizeText(li.textContent));
            }
          }
          return {
            id: crypto.randomUUID(),
            url: sourceUrl,
            title: name,
            ingredients,
            instructions,
            createdAt: Date.now(),
            notes: ''
          };
        }
      }
    } catch(e){ /* ignore parse errors */ }
  }
  // Microdata fallback
  const scope = doc.querySelector('[itemtype*="schema.org/Recipe"], [itemscope][itemtype*="Recipe"]');
  if (scope){
    const name = sanitizeText(scope.querySelector('[itemprop="name"]')?.textContent || doc.querySelector('h1')?.textContent || 'Untitled Recipe');
    const ingredients = Array.from(scope.querySelectorAll('[itemprop="recipeIngredient"], [itemprop="ingredients"]')).map(el=>sanitizeText(el.textContent));
    let instructions = Array.from(scope.querySelectorAll('[itemprop="recipeInstructions"] li')).map(el=>sanitizeText(el.textContent));
    if (!instructions.length){
      instructions = Array.from(doc.querySelectorAll('.instructions li, ol li')).map(el=>sanitizeText(el.textContent)).slice(0, 30);
    }
    return {
      id: crypto.randomUUID(),
      url: sourceUrl,
      title: name,
      ingredients,
      instructions,
      createdAt: Date.now(),
      notes: ''
    };
  }
  // Heuristic: use headings and lists
  const text = doc.body?.innerText || '';
  return parseFromText(text, sourceUrl);
}

async function fetchHTMLViaAllOrigins(url){
  const encoded = encodeURIComponent(url);
  const res = await fetch(`https://api.allorigins.win/raw?url=${encoded}`);
  if (!res.ok) throw new Error('AllOrigins fetch failed');
  return await res.text();
}

async function fetchTextViaJina(url){
  const u = new URL(url);
  const proto = u.protocol.startsWith('https') ? 'https' : 'http';
  const rurl = `https://r.jina.ai/${proto}://${u.host}${u.pathname}${u.search||''}`;
  const res = await fetch(rurl);
  if (!res.ok) throw new Error('Jina Reader fetch failed');
  return await res.text();
}

async function importFromUrl(url){
  setStatus('Fetching recipe…');
  try{
    const html = await fetchHTMLViaAllOrigins(url);
    const recipe = extractRecipeFromHTML(html, url);
    if (!recipe.title || (!recipe.ingredients.length && !recipe.instructions.length)){
      // Fallback to Jina text
      const text = await fetchTextViaJina(url);
      const r2 = parseFromText(text, url);
      if (!r2.ingredients.length && !r2.instructions.length){
        throw new Error('Could not extract ingredients/instructions.');
      }
      await saveRecipe(r2);
      setStatus('Imported via readable text fallback.');
      return r2;
    } else {
      await saveRecipe(recipe);
      setStatus('Imported successfully.');
      return recipe;
    }
  } catch(e){
    console.error(e);
    // try Jina as last fallback
    try {
      const text = await fetchTextViaJina(url);
      const r2 = parseFromText(text, url);
      await saveRecipe(r2);
      setStatus('Imported via readable text fallback.');
      return r2;
    } catch (e2){
      console.error(e2);
      setStatus('Sorry, we could not fetch that page. You can paste ingredients/steps manually in Edit.', 'error');
      throw e2;
    }
  }
}

async function saveRecipe(recipe){
  await idbkv.set(recipe.id, recipe);
  await refreshList();
  return recipe.id;
}

async function refreshList(filter=''){
  const keys = await idbkv.keys();
  const items = [];
  for (const k of keys){
    const v = await idbkv.get(k);
    if (!v) continue;
    items.push(v);
  }
  items.sort((a,b) => b.createdAt - a.createdAt);
  listEl.innerHTML = '';
  const q = filter.trim().toLowerCase();
  let count = 0;
  for (const rec of items){
    if (q && !(rec.title.toLowerCase().includes(q) || domainFromUrl(rec.url).includes(q))) continue;
    const li = document.createElement('li');
    li.className = 'recipe-item';
    li.innerHTML = \`
      <div class="dot" style="width:10px;height:10px;border-radius:50%;background:#22c55e;"></div>
      <div class="stack">
        <div class="title">\${rec.title}</div>
        <div class="domain">\${domainFromUrl(rec.url)}</div>
      </div>\`;
    li.addEventListener('click', () => showDetail(rec.id));
    listEl.appendChild(li);
    count++;
  }
  emptyEl.hidden = count > 0;
}

async function showDetail(id){
  const rec = await idbkv.get(id);
  if (!rec) return;
  detail.dataset.id = id;
  detailTitle.textContent = rec.title || 'Untitled Recipe';
  detailSource.textContent = rec.url || '';
  // meta can show servings / time if available later
  detailMeta.innerHTML = '';
  detailIngredients.innerHTML = '';
  detailInstructions.innerHTML = '';
  for (const ing of rec.ingredients||[]) {
    const li = document.createElement('li'); li.textContent = ing; detailIngredients.appendChild(li);
  }
  for (const step of rec.instructions||[]) {
    const li = document.createElement('li'); li.textContent = step; detailInstructions.appendChild(li);
  }
  notesEl.value = rec.notes || '';
  detail.hidden = false;
  window.scrollTo({top: detail.offsetTop - 8, behavior:'smooth'});
}

backBtn.addEventListener('click', () => { detail.hidden = true; });

deleteBtn.addEventListener('click', async () => {
  const id = detail.dataset.id;
  if (!id) return;
  if (!confirm('Delete this recipe?')) return;
  await idbkv.del(id);
  detail.hidden = true;
  await refreshList(searchInput.value);
});

editBtn.addEventListener('click', async () => {
  const id = detail.dataset.id;
  const rec = await idbkv.get(id);
  if (!rec) return;
  editTitle.value = rec.title || '';
  editIngredients.value = (rec.ingredients||[]).join('\n');
  editInstructions.value = (rec.instructions||[]).join('\n');
  editDialog.showModal();
});

saveEditBtn.addEventListener('click', async (e) => {
  e.preventDefault();
  const id = detail.dataset.id;
  const rec = await idbkv.get(id);
  if (!rec) return;
  rec.title = sanitizeText(editTitle.value);
  rec.ingredients = editIngredients.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  rec.instructions = editInstructions.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  await idbkv.set(id, rec);
  editDialog.close();
  await showDetail(id);
  await refreshList(searchInput.value);
  setStatus('Recipe updated.');
});

saveNotesBtn.addEventListener('click', async () => {
  const id = detail.dataset.id;
  const rec = await idbkv.get(id);
  if (!rec) return;
  rec.notes = notesEl.value;
  await idbkv.set(id, rec);
  setStatus('Notes saved for offline use.');
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  document.getElementById('fetchBtn').disabled = true;
  try{
    const rec = await importFromUrl(url);
    await showDetail(rec.id);
    urlInput.value='';
  } finally {
    document.getElementById('fetchBtn').disabled = false;
  }
});

searchInput.addEventListener('input', () => refreshList(searchInput.value));

exportBtn.addEventListener('click', async () => {
  const keys = await idbkv.keys();
  const items = [];
  for (const k of keys){
    const v = await idbkv.get(k);
    if (v) items.push(v);
  }
  const blob = new Blob([JSON.stringify(items, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'recipes-export.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

importBtn.addEventListener('click', ()=> importFile.click());
importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  if (!file) return;
  const text = await file.text();
  try{
    const arr = JSON.parse(text);
    for (const rec of arr){
      if (!rec.id) rec.id = crypto.randomUUID();
      await idbkv.set(rec.id, rec);
    }
    await refreshList(searchInput.value);
    setStatus('Import complete.');
  }catch(e){
    console.error(e);
    setStatus('Import failed: invalid JSON.', 'error');
  } finally {
    importFile.value = '';
  }
});

// On load
refreshList();

// --- Web Share Target: handle ?url= on launch ---
(function handleShareTargetOnLoad(){
  try {
    const params = new URLSearchParams(window.location.search);
    const sharedUrl = params.get('url');
    if (sharedUrl) {
      urlInput.value = sharedUrl;
      importFromUrl(sharedUrl)
        .then(r => showDetail(r.id))
        .catch(() => setStatus('Could not import shared link.', 'error'));
    }
  } catch (e) {
    console.warn('Share Target parse failed', e);
  }
})();
// --- end share target handler ---

