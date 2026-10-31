import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');
const dbFilePath = path.join(dataDir, 'lifestyle.db');
const fallbackJsonPath = path.join(dataDir, 'lifestyle_store.json');

// Khởi tạo in-memory cache dự phòng tối ưu
let memoryStore = {
  users: [
    {
      name: "Nguyễn Văn An",
      email: "an.demo@lifestyle.pro",
      height: 172,
      weight: 66,
      gender: "Nam",
      plan: "FREE",
      ai_usage_count: 0,
      last_usage_date: ""
    }
  ],
  wardrobe_items: [
    {
      id: "1",
      user_email: "an.demo@lifestyle.pro",
      name: "Áo sơ mi Oxford",
      category: "Áo",
      color: "Trắng",
      image_url: "https://images.unsplash.com/photo-1598033129183-c4f50c736f10?w=500&auto=format&fit=crop&q=80"
    },
    {
      id: "2",
      user_email: "an.demo@lifestyle.pro",
      name: "Áo thun đen tối giản",
      category: "Áo",
      color: "Đen",
      image_url: "https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=500&auto=format&fit=crop&q=80"
    },
    {
      id: "3",
      user_email: "an.demo@lifestyle.pro",
      name: "Quần Jeans Slimfit",
      category: "Quần/Váy",
      color: "Xanh Jeans",
      image_url: "https://images.unsplash.com/photo-1542272604-780c96856592?w=500&auto=format&fit=crop&q=80"
    },
    {
      id: "4",
      user_email: "an.demo@lifestyle.pro",
      name: "Quần Tây âu công sở",
      category: "Quần/Váy",
      color: "Đen xám",
      image_url: "https://images.unsplash.com/photo-1624378439575-d8705ad7ae80?w=500&auto=format&fit=crop&q=80"
    },
    {
      id: "5",
      user_email: "an.demo@lifestyle.pro",
      name: "Giày Sneaker trắng",
      category: "Giày dép",
      color: "Trắng",
      image_url: "https://images.unsplash.com/photo-1549298916-b41d501d3772?w=500&auto=format&fit=crop&q=80"
    },
    {
      id: "6",
      user_email: "an.demo@lifestyle.pro",
      name: "Đồng hồ dây da",
      category: "Phụ kiện",
      color: "Nâu cà phê",
      image_url: "https://images.unsplash.com/photo-1524805444758-089113d48a6d?w=500&auto=format&fit=crop&q=80"
    }
  ]
};

// Đọc dữ liệu từ file JSON nếu có
try {
  if (fs.existsSync(fallbackJsonPath)) {
    const raw = fs.readFileSync(fallbackJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.users) && Array.isArray(parsed.wardrobe_items)) {
      memoryStore = parsed;
    }
  }
} catch (_) {}

let db = null;
let useFallback = true;

// Thử kết nối SQLite
try {
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(dbFilePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      height REAL DEFAULT 170,
      weight REAL DEFAULT 65,
      gender TEXT DEFAULT 'Nam',
      plan TEXT DEFAULT 'FREE',
      ai_usage_count INTEGER DEFAULT 0,
      last_usage_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS wardrobe_items (
      id TEXT PRIMARY KEY,
      user_email TEXT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      color TEXT,
      image_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  useFallback = false;
  console.log('✅ SQLite Database đã sẵn sàng:', dbFilePath);
} catch {
  useFallback = true;
  console.log('📦 Chế độ File & Memory Database đang hoạt động ổn định.');
}

function persistStore() {
  try {
    fs.writeFileSync(fallbackJsonPath, JSON.stringify(memoryStore, null, 2), 'utf8');
  } catch (_) {
    // Không làm gián đoạn luồng nếu hệ điều hành tạm thời khóa file
  }
}

// ==========================================
// CÁC HÀM CRUD DATABASE CHO USER & WARDROBE
// ==========================================

export function saveOrUpdateUser(userData) {
  const { name, email, height = 170, weight = 65, gender = 'Nam', plan = 'FREE', last_usage_date = '' } = userData;
  if (!email) return null;

  if (!useFallback && db) {
    try {
      const stmt = db.prepare(`
        INSERT INTO users (name, email, height, weight, gender, plan, last_usage_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
          name = excluded.name,
          height = excluded.height,
          weight = excluded.weight,
          gender = excluded.gender,
          plan = excluded.plan;
      `);
      stmt.run(name, email, Number(height), Number(weight), gender, plan, last_usage_date);
      return getUser(email);
    } catch (_) {}
  }

  // Memory & JSON fallback
  const idx = memoryStore.users.findIndex(u => u.email === email);
  const updated = {
    name,
    email,
    height: Number(height),
    weight: Number(weight),
    gender,
    plan,
    last_usage_date,
    ai_usage_count: idx >= 0 ? memoryStore.users[idx].ai_usage_count : 0
  };
  if (idx >= 0) {
    memoryStore.users[idx] = { ...memoryStore.users[idx], ...updated };
  } else {
    memoryStore.users.push(updated);
  }
  persistStore();
  return updated;
}

export function getUser(email) {
  if (!email) return null;
  if (!useFallback && db) {
    try {
      const stmt = db.prepare(`SELECT * FROM users WHERE email = ? LIMIT 1`);
      const row = stmt.get(email);
      if (row) return row;
    } catch (_) {}
  }
  return memoryStore.users.find(u => u.email === email) || null;
}

export function upgradeUserToPro(email) {
  if (!email) return false;
  if (!useFallback && db) {
    try {
      const stmt = db.prepare(`UPDATE users SET plan = 'PRO' WHERE email = ?`);
      stmt.run(email);
    } catch (_) {}
  }
  const user = memoryStore.users.find(u => u.email === email);
  if (user) {
    user.plan = 'PRO';
    persistStore();
    return true;
  }
  return false;
}

export function incrementAIUsage(email, todayDate) {
  if (!email) return;
  if (!useFallback && db) {
    try {
      const user = getUser(email);
      if (user) {
        const currentCount = user.last_usage_date === todayDate ? (user.ai_usage_count || 0) : 0;
        const stmt = db.prepare(`UPDATE users SET ai_usage_count = ?, last_usage_date = ? WHERE email = ?`);
        stmt.run(currentCount + 1, todayDate, email);
      }
    } catch (_) {}
  }
  const user = memoryStore.users.find(u => u.email === email);
  if (user) {
    const currentCount = user.last_usage_date === todayDate ? (user.ai_usage_count || 0) : 0;
    user.ai_usage_count = currentCount + 1;
    user.last_usage_date = todayDate;
    persistStore();
  }
}

export function getWardrobeItems(userEmail) {
  if (!useFallback && db) {
    try {
      if (userEmail) {
        const stmt = db.prepare(`SELECT * FROM wardrobe_items WHERE user_email = ? OR user_email IS NULL ORDER BY created_at DESC`);
        return stmt.all(userEmail);
      } else {
        const stmt = db.prepare(`SELECT * FROM wardrobe_items ORDER BY created_at DESC`);
        return stmt.all();
      }
    } catch (_) {}
  }
  if (userEmail) {
    return memoryStore.wardrobe_items.filter(item => !item.user_email || item.user_email === userEmail);
  }
  return memoryStore.wardrobe_items;
}

export function addWardrobeItem({ id, user_email, name, category, color, image_url }) {
  const itemId = id || Date.now().toString();
  if (!useFallback && db) {
    try {
      const stmt = db.prepare(`
        INSERT INTO wardrobe_items (id, user_email, name, category, color, image_url)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(itemId, user_email || null, name, category, color || '', image_url || '');
    } catch (_) {}
  }

  const item = { id: itemId, user_email, name, category, color, image_url, created_at: new Date().toISOString() };
  memoryStore.wardrobe_items.unshift(item);
  persistStore();
  return item;
}

export function deleteWardrobeItem(id) {
  if (!useFallback && db) {
    try {
      const getStmt = db.prepare(`SELECT image_url FROM wardrobe_items WHERE id = ?`);
      const item = getStmt.get(id);
      if (item && item.image_url && item.image_url.includes('/uploads/')) {
        const filename = path.basename(item.image_url);
        const filePath = path.join(uploadsDir, filename);
        if (fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch (_) {}
        }
      }
      const stmt = db.prepare(`DELETE FROM wardrobe_items WHERE id = ?`);
      stmt.run(id);
    } catch (_) {}
  }

  const item = memoryStore.wardrobe_items.find(i => i.id === id);
  if (item && item.image_url && item.image_url.includes('/uploads/')) {
    const filename = path.basename(item.image_url);
    const filePath = path.join(uploadsDir, filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
  }
  memoryStore.wardrobe_items = memoryStore.wardrobe_items.filter(i => i.id !== id);
  persistStore();
  return true;
}

export function saveBase64Image(base64String) {
  if (!base64String || typeof base64String !== 'string') return null;
  if (base64String.startsWith('http://') || base64String.startsWith('https://')) {
    return base64String;
  }

  const matches = base64String.match(/^data:image\/([a-zA-Z0-9-+]+);base64,(.+)$/);
  if (!matches) return null;

  const extension = matches[1] === 'jpeg' ? 'jpg' : matches[1];
  const dataBuffer = Buffer.from(matches[2], 'base64');
  const filename = `item-${Date.now()}-${Math.round(Math.random() * 1E6)}.${extension}`;
  const filePath = path.join(uploadsDir, filename);

  try {
    fs.writeFileSync(filePath, dataBuffer);
    return `/uploads/${filename}`;
  } catch (err) {
    console.error('Lỗi ghi file ảnh vào uploads:', err);
    return null;
  }
}
