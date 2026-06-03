// CONFIGURACIÓN SUPABASE REAL DE RO
const SUPABASE_URL = 'https://bcsmkbtvmabmcuzeehad.supabase.co';
const SUPABASE_KEY = 'sb_publishable_n6gpg6LRXdKHERrCGMjllw_bKM9vECK';

let client = null;
let inventory = { turbos: [], lubricentro: [] };
let sales = [];
let currentUser = null;
const DEBIT_PERCENT = 1.06;
const CREDIT_PERCENT = 1.096;
let wegaData = [];
let mannData = [];
let currentSelection = { oil: null, air: null, fuel: null, cabin: null };

function parseMoney(val) {
    if (!val) return 0;
    if (typeof val === 'number') return val;
    let clean = val.toString().replace(/\$/g, '').replace(/\s/g, '');
    if (clean.includes(',') && clean.includes('.')) {
        // Point is thousands, comma is decimal (e.g. 67.387,43)
        clean = clean.replace(/\./g, '').replace(',', '.');
    } else if (clean.includes(',')) {
        // Comma is decimal
        clean = clean.replace(',', '.');
    }
    return parseFloat(clean) || 0;
}

const DEFAULT_VEHICLES = {
    "fiorino_14": { name: "Fiat Fiorino 1.4 Fire Evo", oil_type: "5W30", oil_liters: 2.9, filters: ["WEO-0003", "FAP-9054", "FCI-1660", "AKX-1445"] },
    "hilux_24": { name: "Toyota Hilux 2.4/2.8 (2016+)", oil_type: "5W30", oil_liters: 7.5, filters: ["WEO-0014", "JFA-0213", "FCD-2173", "AKX-1965"] }
};

let VEHICLE_DB = { ...DEFAULT_VEHICLES };
let editingIndex = null;

async function init() {
    // 1. Inicializar Supabase inmediatamente para evitar que sea null
    try {
        if (typeof supabase !== 'undefined') {
            client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        }
    } catch (e) { console.warn("Supabase init error:", e); }

    // 2. Configurar componentes básicos
    setupTabs();
    setupAuth();
    setupSearch();
    setupModal();
    setupPOS();
    setupImport();
    setupBudget();
    setupWegaManualImport();
    setupMannManualImport();
    setupServiceModal();
    
    // 3. Cargar archivos y almacenamiento local de forma segura
    try { loadWegaExcel(); } catch (e) { console.warn(e); }
    try { loadMannExcel(); } catch (e) { console.warn(e); }
    try { loadFromLocal(); } catch (e) { console.warn(e); }
    
    // 4. Renderizar pantalla inicial
    try { renderAll(); } catch (e) { console.warn(e); }

    // 5. Revisar si hay una sesión activa de Supabase
    if (client) {
        try {
            const { data } = await client.auth.getSession();
            if (data?.session) {
                currentUser = data.session.user;
                document.getElementById('login-screen').classList.add('hidden');
                await loadFromCloud();
                await loadCustomVehicles();
            }
        } catch (e) { console.warn("Session check error:", e); }
    }
}

function setupAuth() {
    const form = document.getElementById('login-form');
    if (!form) return;
    form.onsubmit = async (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;
        
        // Evitar error de "properties of null (reading 'auth')" si el CDN falló o fue bloqueado
        if (!client) {
            alert("⚠️ No se pudo establecer conexión con el servidor de base de datos.\n\nPor favor:\n1. Asegúrate de estar conectado a internet.\n2. Desactiva bloqueadores de publicidad muy estrictos (como el escudo de Brave Browser o uBlock Origin).\n3. Recarga la página y vuelve a intentar.");
            return;
        }
        
        try {
            const { data, error } = await client.auth.signInWithPassword({ email, password });
            if (error) alert("Error: " + error.message);
            else { 
                currentUser = data.user; 
                document.getElementById('login-screen').classList.add('hidden'); 
                await loadFromCloud(); 
                await loadCustomVehicles(); 
            }
        } catch (err) { alert("Error: " + err.message); }
    };
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.onclick = async () => { if (client) await client.auth.signOut(); location.reload(); };
    }
}

async function fetchAllFromCloud(tableName) {
    let allData = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;
    
    while (hasMore) {
        const { data, error } = await client
            .from(tableName)
            .select('*')
            .range(page * pageSize, (page + 1) * pageSize - 1);
            
        if (error) {
            console.error(`Error al cargar datos de ${tableName} en la página ${page}:`, error);
            throw error;
        }
        
        if (data && data.length > 0) {
            allData = allData.concat(data);
            if (data.length < pageSize) {
                hasMore = false;
            } else {
                page++;
            }
        } else {
            hasMore = false;
        }
    }
    return allData;
}

async function loadFromCloud() {
    if (!client) return;
    try {
        const inv = await fetchAllFromCloud('datos_taller_ro');
        const sls = await fetchAllFromCloud('ventas_taller_ro');
        if (inv) {
            inventory.turbos = inv.filter(i => i.category === 'turbos');
            inventory.lubricentro = inv.filter(i => i.category === 'lubricentro');
            
            // Limpiar duplicados de ventas automáticamente en la vista local
            const uniqueSales = [];
            const seenSales = new Set();
            (sls || []).forEach(s => {
                const key = `${s.name}_${s.price}_${s.date}`;
                if (!seenSales.has(key)) {
                    seenSales.add(key);
                    uniqueSales.push(s);
                }
            });
            sales = uniqueSales;
            
            renderAll();
        }
    } catch (e) { console.error("Error cargando datos de Supabase:", e); }
}

async function syncWithCloud(manual = false) {
    if (!client || !currentUser) return;
    try {
        const all = [...inventory.turbos.map(i=>({...i, category:'turbos'})), ...inventory.lubricentro.map(i=>({...i, category:'lubricentro'}))];
        await client.from('datos_taller_ro').delete().neq('category', 'vehicle_config');
        if (all.length > 0) {
            for (let i = 0; i < all.length; i += 500) await client.from('datos_taller_ro').insert(all.slice(i, i + 500));
        }
        // Ya no sincronizamos todas las ventas aquí para evitar duplicados. Se insertan individualmente en completeSale.
        if (manual) alert("✅ Nube sincronizada");
    } catch (e) { console.error(e); }
}

async function saveData() {
    localStorage.setItem('taller_inventory', JSON.stringify(inventory));
    localStorage.setItem('taller_sales', JSON.stringify(sales));
    await syncWithCloud();
}

function loadFromLocal() {
    try {
        const inv = localStorage.getItem('taller_inventory');
        const sls = localStorage.getItem('taller_sales');
        if (inv) inventory = JSON.parse(inv);
        if (sls) sales = JSON.parse(sls);
    } catch (e) {
        console.warn("Local storage parse error:", e);
    }
}

function renderAll() { renderTurbos(); renderLubricentro(); renderSales(); updateOilSelect(); }

function renderTurbos(filter = '') {
    const tbody = document.querySelector('#table-turbos tbody'); if (!tbody) return;
    tbody.innerHTML = '';
    inventory.turbos.forEach((item, index) => {
        if (filter && !item.name.toLowerCase().includes(filter.toLowerCase())) return;
        const tr = document.createElement('tr');
        const safePrice = parseFloat(item.price) || 0;
        tr.innerHTML = `<td>${item.type || '-'}</td><td><strong>${item.id}</strong></td><td>${item.name}</td><td>${item.vehicle || '-'}</td><td>$${safePrice.toFixed(2)}</td><td class="${item.stock <= 2 ? 'stock-low' : ''}">${item.stock}</td><td><button onclick="changeStock('turbos', ${index}, -1)">-</button><button onclick="changeStock('turbos', ${index}, 1)">+</button><button style="background:#3b82f6; color:white; border-radius:4px; border:none; padding:2px 5px; margin-left:5px;" onclick="openEditModal('turbos', ${index})">✏️</button></td>`;
        tbody.appendChild(tr);
    });
}

function renderLubricentro(filter = '') {
    const tbody = document.querySelector('#table-lubricentro tbody'); if (!tbody) return;
    tbody.innerHTML = '';
    inventory.lubricentro.forEach((item, index) => {
        if (filter && !item.name.toLowerCase().includes(filter.toLowerCase())) return;
        const tr = document.createElement('tr');
        const safePrice = parseFloat(item.price) || 0;
        tr.innerHTML = `<td>${item.type || '-'}</td><td><strong>${item.id}</strong></td><td>${item.name}</td><td>$${safePrice.toFixed(2)}</td><td class="${item.stock <= 5 ? 'stock-low' : ''}">${item.stock}</td><td><button onclick="changeStock('lubricentro', ${index}, -1)">-</button><button onclick="changeStock('lubricentro', ${index}, 1)">+</button><button style="background:#3b82f6; color:white; border-radius:4px; border:none; padding:2px 5px; margin-left:5px;" onclick="openEditModal('lubricentro', ${index})">✏️</button></td>`;
        tbody.appendChild(tr);
    });
}

function renderSales() {
    const tT = document.querySelector('#table-ventas-turbos tbody');
    const tL = document.querySelector('#table-ventas-lubricentro tbody');
    if (!tT || !tL) return;
    tT.innerHTML = ''; tL.innerHTML = '';
    let totT = 0, totL = 0;
    sales.sort((a,b) => new Date(b.date) - new Date(a.date)).forEach(s => {
        const tr = document.createElement('tr');
        const d = new Date(s.date).toLocaleString('es-AR', { dateStyle:'short', timeStyle:'short' });
        const safePrice = parseFloat(s.price) || 0;
        tr.innerHTML = `<td>${d}</td><td><strong>${s.name}</strong></td><td>$${safePrice.toFixed(2)}</td><td><button style="color:red; border:none; background:none; cursor:pointer;" onclick="deleteSale('${s.id}', '${s.date}')">Anular</button></td>`;
        if (s.category === 'turbos') { totT += safePrice; tT.appendChild(tr); }
        else { totL += safePrice; tL.appendChild(tr); }
    });
    document.getElementById('total-sales-turbos').innerText = `$${totT.toFixed(2)}`;
    document.getElementById('total-sales-lubricentro').innerText = `$${totL.toFixed(2)}`;
}

function openEditModal(cat, index) {
    const item = inventory[cat][index]; editingIndex = index;
    document.getElementById('modal-category').value = cat;
    document.getElementById('modal-title').innerText = "Editar Producto";
    document.getElementById('input-type').value = item.type || '';
    document.getElementById('input-code').value = item.id;
    document.getElementById('input-code').disabled = true;
    document.getElementById('input-name').value = item.name;
    document.getElementById('input-vehicle').value = item.vehicle || '';
    document.getElementById('input-price').value = item.price;
    document.getElementById('input-stock').value = item.stock;
    document.getElementById('group-vehicle').style.display = cat === 'turbos' ? 'block' : 'none';
    document.getElementById('add-modal').classList.remove('hidden');
}

function openAddModal(cat) {
    editingIndex = null;
    document.getElementById('modal-category').value = cat;
    document.getElementById('modal-title').innerText = "Agregar Producto";
    document.getElementById('input-code').disabled = false;
    document.getElementById('add-modal').classList.remove('hidden');
}

function closeAddModal() { document.getElementById('add-modal').classList.add('hidden'); }

function setupModal() {
    const form = document.getElementById('add-form');
    form.onsubmit = async (e) => {
        e.preventDefault();
        const cat = document.getElementById('modal-category').value;
        const item = {
            id: document.getElementById('input-code').value.toUpperCase(),
            type: document.getElementById('input-type').value,
            name: document.getElementById('input-name').value,
            price: parseFloat(document.getElementById('input-price').value),
            stock: parseInt(document.getElementById('input-stock').value),
            vehicle: document.getElementById('input-vehicle').value
        };
        if (editingIndex !== null) inventory[cat][editingIndex] = item; else inventory[cat].push(item);
        await saveData(); renderAll(); closeAddModal();
    };
}

function setupImport() {
    document.getElementById('import-turbos').onchange = (e) => handleImport(e, 'turbos');
    document.getElementById('import-lubricentro').onchange = (e) => handleImport(e, 'lubricentro');
}

async function handleImport(event, category) {
    const file = event.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const json = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
            let col = category === 'turbos' ? { id:1, name:2, vehicle:3, stock:6, price:7 } : { id:1, name:2, price:3, stock:6 };
            const items = [];
            for (let i = 1; i < json.length; i++) {
                const r = json[i]; if (!r[col.id]) continue;
                items.push({ id: r[col.id].toString(), name: (r[col.name]||'S/N').toString(), vehicle: col.vehicle ? (r[col.vehicle]||'').toString() : '', price: parseFloat(r[col.price])||0, stock: parseInt(r[col.stock])||0, category });
            }
            inventory[category] = items; await saveData(); renderAll(); alert("Éxito");
        } catch (err) { alert("Error"); }
    };
    reader.readAsArrayBuffer(file);
}

function setupPOS() {
    const input = document.getElementById('pos-search');
    const sugg = document.getElementById('pos-suggestions'); if (!input) return;
    input.oninput = (e) => {
        const q = e.target.value.toLowerCase(); sugg.innerHTML = '';
        if (q.length < 2) return sugg.classList.add('hidden');
        let res = [];
        ['turbos', 'lubricentro'].forEach(cat => inventory[cat].forEach((item, index) => { if (item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q)) res.push({ item, cat, index }); }));
        if (res.length > 0) {
            sugg.classList.remove('hidden');
            res.forEach(r => {
                const div = document.createElement('div'); div.className = 'suggestion-item'; div.innerText = r.item.name;
                div.onclick = () => {
                    const p = r.item; const c = p.price || 0; const d = c * DEBIT_PERCENT; const cr = c * CREDIT_PERCENT;
                    document.getElementById('pos-selected-info').innerHTML = `
                        <div class="pos-card">
                            <div class="pos-header" style="margin-bottom: 12px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px;">
                                <strong style="font-size: 1.1rem; color: var(--foreground);">${p.name}</strong>
                                <span style="font-size: 0.8rem; color: var(--muted-foreground); display: block; margin-top: 2px;">Código: ${p.id}</span>
                            </div>
                            
                            <div style="margin-bottom: 15px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                                <div>
                                    <label style="font-weight: 600; font-size: 0.9rem; color: var(--foreground);">Cant:</label>
                                    <input type="number" id="pos-edit-qty" value="1" min="1" style="max-width: 60px; font-weight: bold; border: 1px solid var(--border); border-radius: var(--radius); padding: 4px 8px;" oninput="updatePOSPrices()">
                                </div>
                                <div>
                                    <label style="font-weight: 600; font-size: 0.9rem; color: var(--foreground);">Precio c/u ($):</label>
                                    <input type="number" id="pos-edit-price" value="${c}" style="max-width: 100px; font-weight: bold; border: 1px solid var(--border); border-radius: var(--radius); padding: 4px 8px;" oninput="updatePOSPrices()">
                                </div>
                            </div>
                            
                            <div class="pos-prices">
                                <div class="price-tag cash">
                                    <span class="label">Efectivo</span>
                                    <span class="value" id="pos-price-cash">$${c.toFixed(2)}</span>
                                    <button class="btn-sell-pos cash" onclick="triggerPOSSale('${r.cat}', ${r.index}, 'Efectivo')">Vender</button>
                                </div>
                                <div class="price-tag debit">
                                    <span class="label">Débito (6%)</span>
                                    <span class="value" id="pos-price-debit">$${d.toFixed(2)}</span>
                                    <button class="btn-sell-pos debit" onclick="triggerPOSSale('${r.cat}', ${r.index}, 'Débito')">Vender</button>
                                </div>
                                <div class="price-tag credit">
                                    <span class="label">Crédito (9.6%)</span>
                                    <span class="value" id="pos-price-credit">$${cr.toFixed(2)}</span>
                                    <button class="btn-sell-pos credit" onclick="triggerPOSSale('${r.cat}', ${r.index}, 'Crédito')">Vender</button>
                                </div>
                            </div>
                        </div>
                    `;
                    input.value = ''; sugg.classList.add('hidden');
                };
                sugg.appendChild(div);
            });
        }
    };
}

function updatePOSPrices() {
    const priceInput = document.getElementById('pos-edit-price');
    const qtyInput = document.getElementById('pos-edit-qty');
    if (!priceInput || !qtyInput) return;
    
    const price = parseFloat(priceInput.value) || 0;
    const qty = parseInt(qtyInput.value) || 1;
    const totalBase = price * qty;
    
    const debitPrice = totalBase * DEBIT_PERCENT;
    const creditPrice = totalBase * CREDIT_PERCENT;
    
    document.getElementById('pos-price-cash').innerText = `$${totalBase.toFixed(2)}`;
    document.getElementById('pos-price-debit').innerText = `$${debitPrice.toFixed(2)}`;
    document.getElementById('pos-price-credit').innerText = `$${creditPrice.toFixed(2)}`;
}

function triggerPOSSale(cat, index, method) {
    const priceInput = document.getElementById('pos-edit-price');
    const qtyInput = document.getElementById('pos-edit-qty');
    if (!priceInput || !qtyInput) return;
    
    const price = parseFloat(priceInput.value) || 0;
    const qty = parseInt(qtyInput.value) || 1;
    const totalBase = price * qty;
    
    let finalPrice = totalBase;
    if (method === 'Débito') finalPrice = totalBase * DEBIT_PERCENT;
    else if (method === 'Crédito') finalPrice = totalBase * CREDIT_PERCENT;
    
    completeSale(cat, index, finalPrice, method, qty);
}

async function completeSale(cat, index, price, method, qty = 1) {
    const item = inventory[cat][index];
    if (item.stock < qty) {
        if (!confirm(`El producto "${item.name}" tiene stock insuficiente (quedan ${item.stock}). ¿Deseas registrar la venta de ${qty} unidades de todas formas?`)) {
            return;
        }
    }
    item.stock -= qty; 
    
    const saleName = qty > 1 ? `${item.name} (x${qty})` : item.name;
    const newSale = { item_id: item.id, name: saleName, category: cat, price, date: new Date().toISOString() };
    
    if (client) {
        const { data } = await client.from('ventas_taller_ro').insert([newSale]).select();
        if (data && data.length > 0) sales.push(data[0]);
        else sales.push(newSale);
    } else {
        sales.push(newSale);
    }
    
    await saveData(); 
    renderAll(); 
    document.getElementById('pos-selected-info').innerHTML = '<div class="status-badge">✅ Vendido</div>';
}

async function deleteSale(id, date) {
    if (!confirm("¿Anular esta venta?")) return;
    const idx = sales.findIndex(s => s.id === id && s.date === date);
    if (idx > -1) {
        const s = sales[idx]; 
        const productCode = s.item_id || s.id;
        const item = inventory[s.category].find(i => i.id === productCode);
        
        let qtyToReturn = 1;
        const match = s.name.match(/\(x(\d+)\)$/);
        if (match) qtyToReturn = parseInt(match[1], 10);
        
        if (item) item.stock += qtyToReturn;
        
        if (client) {
            if (s.id) await client.from('ventas_taller_ro').delete().eq('id', s.id);
            else await client.from('ventas_taller_ro').delete().eq('item_id', productCode).eq('date', date);
        }
        
        sales.splice(idx, 1); 
        await saveData(); 
        renderAll();
    }
}

function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.onclick = () => {
        document.querySelectorAll('.tab-btn, .tab-content').forEach(el => el.classList.remove('active'));
        btn.classList.add('active'); document.getElementById(btn.dataset.tab).classList.add('active');
    });
}

function setupSearch() {
    const st = document.getElementById('search-turbos'), sl = document.getElementById('search-lubricentro');
    if (st) st.oninput = (e) => renderTurbos(e.target.value); if (sl) sl.oninput = (e) => renderLubricentro(e.target.value);
}

function changeStock(cat, idx, amt) { if (inventory[cat][idx].stock + amt >= 0) { inventory[cat][idx].stock += amt; saveData(); renderAll(); } }

async function loadWegaExcel() {
    const status = document.getElementById('wega-status'); if (!status) return;
    try {
        const res = await fetch('precios_limpios.xlsx');
        if (!res.ok) throw new Error("No se encontró el archivo");
        const data = await res.arrayBuffer();
        processWegaData(data);
        status.innerText = "✅ Lista Lista"; status.style.background = "#dcfce7";
    } catch (e) { 
        status.innerText = "⚠️ Subir Excel"; 
        status.style.background = "#fef3c7";
    }
}

function setupWegaManualImport() {
    const input = document.getElementById('import-wega-manual');
    if (input) {
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    processWegaData(event.target.result);
                    alert("✅ Lista de filtros actualizada correctamente");
                    document.getElementById('wega-status').innerText = "✅ Lista Lista";
                    document.getElementById('wega-status').style.background = "#dcfce7";
                } catch (err) {
                    alert("Error al procesar el Excel");
                }
            };
            reader.readAsArrayBuffer(file);
        };
    }
}

function processWegaData(data) {
    const wb = XLSX.read(data);
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    
    // Columnas esperadas: Filtros, Codigo, Descripcion, Precio
    // Mapeo: [0:Filtros, 1:Codigo, 2:Descripcion, 3:Precio]
    wegaData = raw.slice(1).map(row => {
        let price = parseFloat(row[3]) || 0;
        // Lógica: si el precio es bajo (ej: 9.95), multiplicar por 1000 -> 9950
        if (price > 0 && price < 1000) price = price * 1000;
        
        return {
            category: (row[0] || '').toString().toUpperCase(),
            code: (row[1] || '').toString().toUpperCase(),
            desc: (row[2] || '').toString(),
            price: price
        };
    }).filter(item => item.code);
}

async function loadMannExcel() {
    const status = document.getElementById('mann-status'); if (!status) return;
    try {
        const res = await fetch('precios_mann.xlsx');
        if (!res.ok) throw new Error("No se encontró el archivo");
        const data = await res.arrayBuffer();
        processMannData(data);
        status.innerText = "✅ Lista Lista"; status.style.background = "#dcfce7";
    } catch (e) { 
        status.innerText = "⚠️ Subir Excel"; 
        status.style.background = "#fef3c7";
    }
}

function setupMannManualImport() {
    const input = document.getElementById('import-mann-manual');
    if (input) {
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    processMannData(event.target.result);
                    alert("✅ Lista de filtros MANN actualizada correctamente");
                    const status = document.getElementById('mann-status');
                    if (status) {
                        status.innerText = "✅ Lista Lista";
                        status.style.background = "#dcfce7";
                    }
                } catch (err) {
                    alert("Error al procesar el Excel de MANN");
                }
            };
            reader.readAsArrayBuffer(file);
        };
    }
}

function processMannData(data) {
    const wb = XLSX.read(data);
    let combinedRows = [];
    
    // Loop through all sheets in the workbook (Table 1, Table 2, etc.)
    wb.SheetNames.forEach((sheetName) => {
        const sheet = wb.Sheets[sheetName];
        const raw = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        if (!raw || raw.length === 0) return;
        
        // Find the header row by looking for "código" and "precio"
        let headerIdx = -1;
        for (let i = 0; i < Math.min(raw.length, 25); i++) {
            const row = raw[i];
            if (row && row.some(cell => cell && cell.toString().toLowerCase().includes('código')) &&
                row.some(cell => cell && cell.toString().toLowerCase().includes('precio'))) {
                headerIdx = i;
                break;
            }
        }
        
        // Fallback if no header row found with those keywords
        if (headerIdx === -1) {
            for (let i = 0; i < Math.min(raw.length, 10); i++) {
                if (raw[i] && raw[i].length >= 3 && raw[i][0] && raw[i][3]) {
                    headerIdx = i - 1;
                    break;
                }
            }
        }
        
        if (headerIdx === -1) headerIdx = 0;
        
        const heads = (raw[headerIdx] || []).map(h => (h || '').toString().toLowerCase().trim());
        
        let col = {
            code: heads.findIndex(h => h.includes('código') || h.includes('codigo') || h.includes('artículo') || h.includes('articulo')),
            desc: heads.findIndex(h => h.includes('resumen') || h.includes('aplicación') || h.includes('aplicacion') || h.includes('descripción') || h.includes('descripcion') || h.includes('modelo')),
            price: heads.findIndex(h => h.includes('precio') || h.includes('sin iva') || h.includes('unit')),
            class: heads.findIndex(h => h.includes('clasificación') || h.includes('clasificacion') || h.includes('tipo') || h.includes('org'))
        };
        
        if (col.code === -1) col.code = 0;
        if (col.desc === -1) col.desc = 2;
        if (col.price === -1) col.price = 3;
        if (col.class === -1) col.class = 4;
        
        const dataRows = raw.slice(headerIdx + 1);
        dataRows.forEach(row => {
            let code = (row[col.code] || '').toString().toUpperCase().trim();
            let desc = (row[col.desc] || '').toString().trim();
            let price = parseMoney(row[col.price]) || 0;
            let classification = col.class !== -1 ? (row[col.class] || '').toString().toLowerCase().trim() : '';
            
            // Skip rows that are header duplicates or empty
            if (!code || code === 'CÓDIGO' || code === 'CODIGO' || price === 0) return;
            
            // Add 12% markup as requested by the user
            price = price * 1.12;
            
            // Deduce category
            let category = '';
            const lowerDesc = desc.toLowerCase();
            const lowerClass = classification.toLowerCase();
            
            if (lowerDesc.includes('aceite') || lowerClass.includes('aceite') || code.startsWith('W ') || code.startsWith('HU') || code.startsWith('WP') || code.startsWith('W8') || code.startsWith('W9') || code.startsWith('W7')) {
                category = 'OIL';
            } else if (lowerDesc.includes('aire') || lowerClass.includes('aire') || code.startsWith('C ') || code.startsWith('CF')) {
                category = 'AIR';
            } else if (lowerDesc.includes('combustible') || lowerDesc.includes('nafta') || lowerDesc.includes('gasoil') || lowerDesc.includes('diesel') || lowerClass.includes('combustible') || lowerClass.includes('nafta') || lowerClass.includes('gasoil') || lowerClass.includes('diesel') || code.startsWith('WK') || code.startsWith('PU')) {
                category = 'FUEL';
            } else if (lowerDesc.includes('habitaculo') || lowerDesc.includes('polen') || lowerDesc.includes('cabina') || lowerClass.includes('habitaculo') || lowerClass.includes('polen') || lowerClass.includes('cabina') || code.startsWith('CU') || code.startsWith('FP')) {
                category = 'CABIN';
            }
            
            combinedRows.push({
                category: category,
                code: code,
                desc: desc,
                price: price,
                brand: 'MANN'
            });
        });
    });
    
    mannData = combinedRows;
}

function updateOilSelect() {
    const select = document.getElementById('budget-oil-select');
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '<option value="">-- Seleccionar Aceite --</option>';
    
    inventory.lubricentro.forEach(item => {
        const option = document.createElement('option');
        option.value = item.id;
        option.innerText = `${item.name} ($${item.price}/L)`;
        if (item.id === currentVal) option.selected = true;
        select.appendChild(option);
    });
}

// --- PRESUPUESTO INTERACTIVO ---
function setupBudget() {
    const btnSearch = document.getElementById('btn-search-budget');
    const btnSave = document.getElementById('btn-save-vehicle');
    const btnWA = document.getElementById('btn-whatsapp');
    const laborInput = document.getElementById('budget-labor');

    btnSearch.onclick = () => {
        const query = document.getElementById('budget-search').value.toLowerCase().trim();
        if (query.length < 3) return alert("Escriba marca y modelo");
        
        // Primero buscar en base de datos de modelos guardados
        const saved = Object.values(VEHICLE_DB).find(v => v.name.toLowerCase().includes(query) || query.includes(v.name.toLowerCase()));
        if (saved) {
            alert("¡Modelo encontrado en tus archivos!");
            loadVehicleConfig(saved);
            return;
        }

        // Si no está, buscar en WEGA
        searchInWega(query);
    };

    laborInput.oninput = () => calculateBudgetTotal();
    document.getElementById('budget-oil-liters').oninput = () => calculateBudgetTotal();
    document.getElementById('budget-oil-select').onchange = () => {
        const select = document.getElementById('budget-oil-select');
        const oilId = select.value;
        const oilProd = inventory.lubricentro.find(i => i.id === oilId);
        if (oilProd) {
            currentSelection.oil_price_l = oilProd.price;
            currentSelection.oil_name = oilProd.name;
        } else {
            currentSelection.oil_price_l = 0;
            currentSelection.oil_name = null;
        }
        calculateBudgetTotal();
    };
    btnWA.onclick = () => copyBudgetToWhatsApp();
    btnSave.onclick = () => saveCurrentVehicleConfig();
}

function searchInWega(query) {
    const words = query.split(' ');
    const resultsContainer = document.getElementById('wega-results-container');
    const optionsGrid = document.getElementById('wega-options');
    optionsGrid.innerHTML = '';
    
    const categories = {
        oil: { title: "🛢️ Aceite (WEO/WO / HU/WP/W)", filters: [] },
        air: { title: "🌬️ Aire (FAP/WAP / C/CF)", filters: [] },
        fuel: { title: "⛽ Combustible (FCI/FCD/FCE / WK/PU)", filters: [] },
        cabin: { title: "🏠 Habitáculo (AKX / CU/FP)", filters: [] }
    };

    // WEGA search
    wegaData.forEach(item => {
        const desc = item.desc.toLowerCase();
        const code = item.code;
        const catName = item.category.toLowerCase();
        
        if (words.every(w => desc.includes(w))) {
            let type = null;
            if (catName.includes('aceite') || code.startsWith('WEO') || code.startsWith('WO')) type = 'oil';
            else if (catName.includes('aire') || code.startsWith('FAP') || code.startsWith('WAP')) type = 'air';
            else if (catName.includes('combustible') || catName.includes('diesel') || catName.includes('inyeccion') || code.startsWith('FCI') || code.startsWith('FCD') || code.startsWith('FCE')) type = 'fuel';
            else if (catName.includes('habitaculo') || catName.includes('polen') || code.startsWith('AKX')) type = 'cabin';
            
            if (type) categories[type].filters.push({ code, desc: item.desc, price: item.price, brand: 'WEGA' });
        }
    });

    // MANN search
    mannData.forEach(item => {
        const desc = item.desc.toLowerCase();
        const code = item.code.toUpperCase().trim();
        const catName = item.category ? item.category.toLowerCase() : '';
        
        if (words.every(w => desc.includes(w))) {
            let type = null;
            if (catName.includes('oil') || code.startsWith('W ') || code.startsWith('HU') || code.startsWith('WP') || code.startsWith('W8') || code.startsWith('W9') || code.startsWith('W7')) type = 'oil';
            else if (catName.includes('air') || code.startsWith('C ') || code.startsWith('CF')) type = 'air';
            else if (catName.includes('fuel') || code.startsWith('WK') || code.startsWith('PU')) type = 'fuel';
            else if (catName.includes('cabin') || code.startsWith('CU') || code.startsWith('FP')) type = 'cabin';
            
            if (type) categories[type].filters.push({ code, desc: item.desc, price: item.price, brand: 'MANN' });
        }
    });

    Object.keys(categories).forEach(type => {
        const cat = categories[type];
        if (cat.filters.length > 0) {
            const header = document.createElement('h5'); header.innerText = cat.title;
            optionsGrid.appendChild(header);
            
            cat.filters.slice(0, 6).forEach((f, idx) => {
                const item = document.createElement('div');
                item.className = 'option-item';
                const brandColor = f.brand === 'MANN' ? '#15803d' : '#1e3a8a';
                const brandText = f.brand === 'MANN' ? 'MANN' : 'WEGA';
                
                item.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <strong>${f.code}</strong>
                        <span style="background:${brandColor}; color:white; font-size:0.7rem; font-weight:bold; padding:2px 6px; border-radius:4px;">${brandText}</span>
                    </div>
                    <small>${f.desc}</small>
                    <div style="color:var(--primary); font-weight:bold;">$${(f.price * 1.6).toFixed(0)}</div>
                `;
                item.onclick = () => selectFilter(type, f);
                optionsGrid.appendChild(item);
                
                if (idx === 0 && !currentSelection[type]) selectFilter(type, f);
            });
        }
    });

    resultsContainer.classList.remove('hidden');
}

function selectFilter(type, filter) {
    currentSelection[type] = filter;
    document.getElementById(`sel-${type}`).innerText = `[${filter.brand}] ${filter.code}`;
    
    if (type === 'oil') {
        const q = document.getElementById('budget-search').value.toLowerCase();
        const isHeavy = ['hilux','ranger','frontier','amarok','s10','toro'].some(m => q.includes(m));
        currentSelection.oil_liters = isHeavy ? 8 : 4;
        
        const oilProd = inventory.lubricentro.find(o => o.name.toLowerCase().includes('5w30') || o.name.toLowerCase().includes('10w40'));
        if (oilProd) {
            currentSelection.oil_price_l = oilProd.price;
            currentSelection.oil_name = oilProd.name;
        }
    }
    
    calculateBudgetTotal();
}

function loadVehicleConfig(v) {
    document.getElementById('budget-search').value = v.name;
    
    v.filters.forEach(code => {
        let item = wegaData.find(r => r.code === code.toUpperCase());
        let brand = 'WEGA';
        if (!item) {
            item = mannData.find(r => r.code === code.toUpperCase());
            brand = 'MANN';
        }
        
        const filterObj = { code, desc: item ? item.desc : 'Filtro Guardado', price: item ? item.price : 0, brand };
        
        if (code.startsWith('WEO') || code.startsWith('WO') || code.startsWith('W ') || code.startsWith('HU') || code.startsWith('WP') || code.startsWith('W7') || code.startsWith('W8') || code.startsWith('W9')) selectFilter('oil', filterObj);
        else if (code.startsWith('FAP') || code.startsWith('WAP') || code.startsWith('C ') || code.startsWith('CF')) selectFilter('air', filterObj);
        else if (code.startsWith('FCI') || code.startsWith('FCD') || code.startsWith('FCE') || code.startsWith('WK') || code.startsWith('PU')) selectFilter('fuel', filterObj);
        else if (code.startsWith('AKX') || code.startsWith('CU') || code.startsWith('FP')) selectFilter('cabin', filterObj);
    });

    if (v.oil_liters) currentSelection.oil_liters = v.oil_liters;
    calculateBudgetTotal();
}

function calculateBudgetTotal() {
    const itemsDiv = document.getElementById('budget-items');
    const totalDiv = document.getElementById('budget-total');
    const resultCard = document.getElementById('budget-result');
    
    itemsDiv.innerHTML = '';
    let total = 0;
    
    Object.keys(currentSelection).forEach(type => {
        const f = currentSelection[type];
        if (f && type !== 'oil_liters' && type !== 'oil_price_l' && type !== 'oil_name') {
            const price = f.price * 1.6;
            total += price;
            itemsDiv.innerHTML += `<p><span>[${f.brand}] ${type.toUpperCase()} (${f.code})</span> <span>$${price.toFixed(0)}</span></p>`;
        }
    });

    const oilLiters = parseFloat(document.getElementById('budget-oil-liters').value) || 0;
    if (currentSelection.oil_price_l && oilLiters > 0) {
        const cost = currentSelection.oil_price_l * oilLiters;
        total += cost;
        itemsDiv.innerHTML += `<p><span>Aceite (${currentSelection.oil_name} x${oilLiters}L)</span> <span>$${cost.toFixed(0)}</span></p>`;
    }

    const labor = parseFloat(document.getElementById('budget-labor').value) || 0;
    if (labor > 0) {
        total += labor;
        itemsDiv.innerHTML += `<p><span>Mano de Obra</span> <span>$${labor.toFixed(0)}</span></p>`;
    }

    totalDiv.innerHTML = `<h3>Total: $${total.toFixed(0)}</h3>`;
    resultCard.classList.remove('hidden');
}

async function saveCurrentVehicleConfig() {
    const name = document.getElementById('budget-search').value;
    if (!name || !currentSelection.oil) return alert("Seleccione al menos el auto y el filtro de aceite");
    
    const v = {
        id: 'v_' + Date.now(),
        name: name.toUpperCase(),
        oil_liters: currentSelection.oil_liters || 4,
        filters: [
            currentSelection.oil?.code,
            currentSelection.air?.code,
            currentSelection.fuel?.code,
            currentSelection.cabin?.code
        ].filter(f => f)
    };

    if (client) {
        const { error } = await client.from('datos_taller_ro').insert([{ category: 'vehicle_config', name: v.name, price: v.oil_liters, vehicle: JSON.stringify(v) }]);
        if (error) alert("Error: " + error.message);
        else {
            alert("¡Vehículo guardado en tu base de datos!");
            VEHICLE_DB[v.id] = v;
        }
    }
}

function copyBudgetToWhatsApp() {
    const name = document.getElementById('budget-search').value.toUpperCase();
    const items = document.getElementById('budget-items').innerText;
    const total = document.getElementById('budget-total').innerText;
    const text = `📋 *Presupuesto Service - Taller Ro*\n🚗 *Vehículo:* ${name}\n\n${items}\n💰 *${total}*\n\n_Precios sujetos a cambios._`;
    navigator.clipboard.writeText(text).then(() => alert("¡Copiado para WhatsApp!"));
}

async function loadCustomVehicles() {
    if (!client) return;
    const { data } = await client.from('datos_taller_ro').select('*').eq('category', 'vehicle_config');
    if (data) data.forEach(row => { const v = JSON.parse(row.vehicle); VEHICLE_DB[v.id || row.id] = v; });
}

// --- SERVICE MANUAL ---
function openServiceModal() {
    document.getElementById('service-vehicle').value = '';
    document.getElementById('service-price').value = '';
    document.getElementById('service-notes').value = '';
    document.getElementById('service-modal').classList.remove('hidden');
}

function closeServiceModal() {
    document.getElementById('service-modal').classList.add('hidden');
}

function setupServiceModal() {
    const form = document.getElementById('service-form');
    if (!form) return;
    form.onsubmit = async (e) => {
        e.preventDefault();
        const vehicle = document.getElementById('service-vehicle').value;
        const price = parseFloat(document.getElementById('service-price').value) || 0;
        const notes = document.getElementById('service-notes').value;
        
        let saleName = `⚙️ SERVICE: ${vehicle}`;
        if (notes) saleName += ` - ${notes}`;
        
        const newSale = { 
            item_id: "SERVICE", 
            name: saleName, 
            category: "lubricentro", 
            price: price, 
            date: new Date().toISOString() 
        };
        
        if (client) {
            const { data } = await client.from('ventas_taller_ro').insert([newSale]).select();
            if (data && data.length > 0) sales.push(data[0]);
            else sales.push(newSale);
        } else {
            sales.push(newSale);
        }
        
        await saveData();
        renderAll();
        closeServiceModal();
    };
}

init();
