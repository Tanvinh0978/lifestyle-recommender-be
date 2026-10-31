import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Groq from 'groq-sdk';
import {
  saveOrUpdateUser,
  getUser,
  upgradeUserToPro,
  incrementAIUsage,
  getWardrobeItems,
  addWardrobeItem,
  deleteWardrobeItem,
  saveBase64Image
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const app = express();
app.use(cors());

// Hỗ trợ upload ảnh dạng base64 qua JSON lên đến 25MB
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Phục vụ ảnh tĩnh trang phục (/uploads/...)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Khởi tạo kết nối với Groq AI
const groqApiKey = process.env.GROQ_API_KEY || '';
const groqModel = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';

let groq = null;
if (groqApiKey && !groqApiKey.startsWith('AQ.')) {
  groq = new Groq({ apiKey: groqApiKey });
}

// Helper kiểm tra API key
function checkGroqClient(res) {
  if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY.trim() === '' || process.env.GROQ_API_KEY.startsWith('AQ.')) {
    res.status(400).json({
      success: false,
      message: "⚠️ Chưa có GROQ_API_KEY hợp lệ! Vui lòng mở file 'lifestyle-recommender-be/.env' và điền GROQ_API_KEY của bạn (Lấy API key hoàn toàn MIỄN PHÍ tại: https://console.groq.com/keys)."
    });
    return false;
  }
  return true;
}

// Helper gọi Groq Chat Completion siêu tốc với fallback
async function callGroq({ messages, jsonMode = true, temperature = 0.6, max_tokens = 1200 }) {
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  const model = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';

  try {
    const payload = {
      model,
      messages,
      temperature,
      max_tokens
    };
    if (jsonMode) {
      payload.response_format = { type: 'json_object' };
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || `Groq API HTTP ${response.status}`);
    }

    const raw = data.choices?.[0]?.message?.content || '{}';
    if (!jsonMode) return raw;

    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.warn("Native Groq fetch fallback triggered:", err.message);
    if (!groq) {
      groq = new Groq({ apiKey });
    }
    const completion = await groq.chat.completions.create({
      model,
      messages,
      response_format: jsonMode ? { type: 'json_object' } : undefined,
      temperature,
      max_tokens
    });
    const rawContent = completion.choices[0]?.message?.content || '{}';
    if (!jsonMode) return rawContent;
    const cleaned = rawContent.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  }
}

function normalizeText(str) {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function matchCategory(cat1, cat2) {
  if (!cat1 || !cat2) return false;
  const n1 = normalizeText(cat1);
  const n2 = normalizeText(cat2);
  return n1 === n2 || n1.includes(n2) || n2.includes(n1);
}

function matchWardrobeItem(wardrobeItems, category, aiItem) {
  if (!Array.isArray(wardrobeItems) || wardrobeItems.length === 0) return null;
  const itemsInCat = wardrobeItems.filter(w => !category || matchCategory(w.category, category));
  if (itemsInCat.length === 0) return null;

  const itemName = typeof aiItem === 'object' ? (aiItem.item || aiItem.name) : (typeof aiItem === 'string' ? aiItem : '');
  const cleanTarget = normalizeText(itemName);

  if (cleanTarget) {
    const directMatch = itemsInCat.find(w => {
      const cleanW = normalizeText(w.name);
      return cleanTarget.includes(cleanW) || cleanW.includes(cleanTarget);
    });
    if (directMatch) return directMatch;
  }

  if (typeof aiItem === 'object' && (aiItem.fromWardrobe || aiItem.isOwned)) {
    return itemsInCat[0];
  }

  return null;
}

function formatBackendOutfit(resultData, { occasion, weather, wardrobeItems = [] }) {
  const ownedTop = wardrobeItems.find(i => i.category === 'Áo');
  const ownedBottom = wardrobeItems.find(i => i.category === 'Quần/Váy');
  const ownedShoes = wardrobeItems.find(i => i.category === 'Giày dép');
  const ownedAccessory = wardrobeItems.find(i => i.category === 'Phụ kiện');

  const topName = typeof resultData?.top === 'object' ? resultData.top.item : (resultData?.top || (ownedTop ? ownedTop.name : 'Sơ mi lụa tơ tằm'));
  const bottomName = typeof resultData?.bottom === 'object' ? resultData.bottom.item : (resultData?.bottom || (ownedBottom ? ownedBottom.name : 'Quần âu ống suông cạp cao'));
  const shoesName = typeof resultData?.shoes === 'object' ? resultData.shoes.item : (resultData?.shoes || (ownedShoes ? ownedShoes.name : 'Loafers da trơn màu kem sữa'));
  const accessoryName = Array.isArray(resultData?.accessories) && resultData.accessories.length > 0 
    ? resultData.accessories[0] 
    : (ownedAccessory ? ownedAccessory.name : 'Túi xách da kẹp nách baguette');

  // Match với wardrobe item
  const matchedTop = matchWardrobeItem(wardrobeItems, 'Áo', resultData?.top) || (resultData?.top?.fromWardrobe ? ownedTop : null);
  const matchedBottom = matchWardrobeItem(wardrobeItems, 'Quần/Váy', resultData?.bottom) || (resultData?.bottom?.fromWardrobe ? ownedBottom : null);
  const matchedShoes = matchWardrobeItem(wardrobeItems, 'Giày dép', resultData?.shoes) || (resultData?.shoes?.fromWardrobe ? ownedShoes : null);
  const matchedAcc = matchWardrobeItem(wardrobeItems, 'Phụ kiện', accessoryName) || ownedAccessory || null;

  const items = [
    {
      slot: 'Áo chính',
      name: matchedTop ? matchedTop.name : topName,
      color: matchedTop ? matchedTop.color : 'Tone thanh lịch',
      isOwned: !!matchedTop,
      imageUrl: matchedTop ? (matchedTop.imageUrl || matchedTop.image_url) : 'https://images.unsplash.com/photo-1598033129183-c4f50c736f10?w=500&auto=format&fit=crop&q=80',
      note: typeof resultData?.top === 'object' && resultData.top.reason ? resultData.top.reason : (matchedTop ? 'Đã có sẵn trong tủ đồ của bạn' : 'Chất liệu thoáng nhẹ, tôn dáng')
    },
    {
      slot: 'Quần / Váy',
      name: matchedBottom ? matchedBottom.name : bottomName,
      color: matchedBottom ? matchedBottom.color : 'Be / Tự nhiên',
      isOwned: !!matchedBottom,
      imageUrl: matchedBottom ? (matchedBottom.imageUrl || matchedBottom.image_url) : 'https://images.unsplash.com/photo-1624378439575-d8705ad7ae80?w=500&auto=format&fit=crop&q=80',
      note: typeof resultData?.bottom === 'object' && resultData.bottom.reason ? resultData.bottom.reason : (matchedBottom ? 'Đã có sẵn trong tủ đồ của bạn' : 'Cạp cao che khuyết điểm, tạo hiệu ứng chân dài')
    },
    {
      slot: 'Giày dép',
      name: matchedShoes ? matchedShoes.name : shoesName,
      color: matchedShoes ? matchedShoes.color : 'Kem / Đen',
      isOwned: !!matchedShoes,
      imageUrl: matchedShoes ? (matchedShoes.imageUrl || matchedShoes.image_url) : 'https://images.unsplash.com/photo-1549298916-b41d501d3772?w=500&auto=format&fit=crop&q=80',
      note: matchedShoes ? 'Đã có sẵn trong tủ đồ của bạn' : 'Di chuyển êm ái cả ngày không đau mỏi chân'
    },
    {
      slot: 'Phụ kiện',
      name: matchedAcc ? matchedAcc.name : accessoryName,
      color: matchedAcc ? matchedAcc.color : 'Tone đồng điệu',
      isOwned: !!matchedAcc,
      imageUrl: matchedAcc ? (matchedAcc.imageUrl || matchedAcc.image_url) : 'https://images.unsplash.com/photo-1524805444758-089113d48a6d?w=500&auto=format&fit=crop&q=80',
      note: matchedAcc ? 'Đã có sẵn trong tủ đồ của bạn' : 'Điểm nhấn tinh tế hoàn thiện set đồ'
    }
  ];

  const missingItemText = typeof resultData.missingItemSuggestion === 'string'
    ? resultData.missingItemSuggestion
    : 'Khăn lụa hoặc trang sức bạc tối giản';

  return {
    ...resultData,
    title: resultData.title || `Bản phối ${occasion} (Phong cách Tối giản & Tinh tế)`,
    occasion,
    weather,
    harmonyScore: Number(resultData.harmonyScore) || 97,
    items,
    missingSuggestion: {
      name: missingItemText,
      category: 'Phụ kiện / Món đồ thêm',
      estimatedPrice: '190.000₫ - 350.000₫',
      storeSuggestion: 'Shopee Mall / Local Brand',
      reason: 'Tạo điểm nhấn và nâng tầm phong cách cho toàn bộ set đồ.'
    },
    stylingAdvice: resultData.stylingAdvice || resultData.stylingTip || 'Sơ vin nhẹ vạt trước và giữ phong thái tự tin để toát lên vẻ cuốn hút nhất.'
  };
}

function formatBackendFitness(resultData, { goal, dietPreference, durationMinutes, targetCalories = 2000 }) {
  const mealsObj = resultData.meals || {};
  const mealKeys = [
    { key: 'breakfast', name: 'Bữa sáng', time: '07:00 - 08:00', defaultDish: 'Cháo yến mạch ức gà & trứng chần' },
    { key: 'lunch', name: 'Bữa trưa', time: '12:00 - 13:00', defaultDish: 'Cơm gạo lứt, cá áp chảo & canh rau cải' },
    { key: 'snack', name: 'Bữa phụ chiều', time: '16:00 - 16:30', defaultDish: 'Trái cây tươi & hạnh nhân mộc' },
    { key: 'dinner', name: 'Bữa tối', time: '18:30 - 19:30', defaultDish: 'Thịt nạc luộc cuốn bánh tráng & rau ghém' }
  ];

  const meals = mealKeys.map(mk => {
    const m = mealsObj[mk.key] || {};
    return {
      name: mk.name,
      time: mk.time,
      dish: m.name || mk.defaultDish,
      calories: Number(m.calories) || Math.round(targetCalories * 0.25),
      ingredients: m.macros ? [m.macros] : ['Cân bằng đa lượng', 'Gia vị tự nhiên thanh nhẹ'],
      tip: m.macros ? `Dinh dưỡng: ${m.macros}` : 'Duy trì năng lượng bền bỉ cho cơ thể.'
    };
  });

  const rawExercises = resultData.workout?.exercises || [];
  const exercises = rawExercises.map((ex, idx) => ({
    id: `ex_${idx + 1}`,
    name: ex.name || 'Bài tập vận động',
    targetMuscle: resultData.workout?.focusArea || 'Toàn thân & Cơ lõi',
    sets: Number(ex.sets) || 3,
    reps: String(ex.reps || '12-15 lần'),
    rest: `${ex.restSeconds || 45} giây`,
    instructions: ex.tip || 'Giữ nhịp thở đều và siết chặt cơ khi thực hiện.'
  }));

  const totalMealCalories = meals.reduce((sum, m) => sum + (Number(m.calories) || 0), 0);
  const targetCals = Number(resultData.healthMetrics?.targetCalories) || targetCalories;
  const waterLiters = Number(resultData.healthMetrics?.waterIntakeLiters) || 2.2;

  return {
    ...resultData,
    goalName: goal,
    dietName: dietPreference,
    durationMinutes: Number(durationMinutes || resultData.workout?.durationMinutes || 30),
    dailyCalorieTarget: targetCals,
    totalMealCalories: totalMealCalories || targetCals,
    waterTargetMl: Math.round(waterLiters * 1000),
    meals,
    exercises
  };
}

// ==========================================
// REST APIS CHO DATABASE (USER & WARDROBE)
// ==========================================

// 1. Đồng bộ thông tin khách hàng vào Database
app.post('/api/users/sync', (req, res) => {
  try {
    const user = saveOrUpdateUser(req.body);
    return res.json({ success: true, user });
  } catch (err) {
    console.error('Lỗi sync user:', err);
    return res.status(500).json({ success: false, message: 'Lỗi lưu thông tin người dùng.' });
  }
});

// 2. Lấy thông tin khách hàng theo email
app.get('/api/users/:email', (req, res) => {
  try {
    const user = getUser(req.params.email);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng.' });
    return res.json({ success: true, user });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Nâng cấp khách hàng lên gói PRO
app.post('/api/users/upgrade-pro', (req, res) => {
  try {
    const { email } = req.body;
    upgradeUserToPro(email);
    const updated = getUser(email);
    return res.json({ success: true, user: updated });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Lấy danh sách trang phục trong tủ đồ từ Database
app.get('/api/wardrobe', (req, res) => {
  try {
    const { email } = req.query;
    const items = getWardrobeItems(email);
    return res.json({ success: true, items });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 5. Thêm trang phục mới vào tủ đồ (hỗ trợ upload ảnh thật lưu vào /uploads/)
app.post('/api/wardrobe', (req, res) => {
  try {
    const { id, user_email, name, category, color, image, image_url } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Tên món đồ không được để trống.' });
    }

    let finalImageUrl = image_url || '';
    if (image && image.startsWith('data:image/')) {
      const savedPath = saveBase64Image(image);
      if (savedPath) {
        finalImageUrl = `http://localhost:${process.env.PORT || 5000}${savedPath}`;
      }
    }

    const newItem = addWardrobeItem({
      id,
      user_email,
      name: name.trim(),
      category: category || 'Áo',
      color: color || 'Tự nhiên',
      image_url: finalImageUrl
    });

    return res.json({ success: true, item: newItem });
  } catch (err) {
    console.error('Lỗi thêm trang phục:', err);
    return res.status(500).json({ success: false, message: 'Lỗi lưu trang phục vào database.' });
  }
});

// 6. Xóa trang phục khỏi tủ đồ và xóa file ảnh
app.delete('/api/wardrobe/:id', (req, res) => {
  try {
    deleteWardrobeItem(req.params.id);
    return res.json({ success: true, message: 'Đã xóa món đồ thành công.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// ENDPOINT 1: AI STYLIST (DÙNG GROQ LPU INFERENCE ENGINE)
// ==========================================
app.post('/api/recommend-outfit', async (req, res) => {
  try {
    if (!checkGroqClient(res)) return;

    const {
      gender = 'Nam',
      weather = 'Nắng mát 26°C',
      occasion = 'Đi làm văn phòng',
      stylePreference = 'Thanh lịch (Smart Casual)',
      onlyUseWardrobe = false,
      wardrobeItems = [],
      userEmail = ''
    } = req.body;

    const wardrobeDescription = Array.isArray(wardrobeItems) && wardrobeItems.length > 0
      ? wardrobeItems.map((item, index) => `${index + 1}. [${item.category || 'Món đồ'}] ${item.name} (Màu: ${item.color || 'Tự nhiên'})`).join('\n')
      : 'Tủ đồ hiện tại chưa có món nào.';

    const systemPrompt = `
Bạn là AI Personal Fashion Stylist hàng đầu. Hãy phối 1 set đồ xuất sắc nhất cho người dùng.
BẮT BUỘC trả về duy nhất 1 JSON object hợp lệ (không kèm markdown ngoài JSON, không giải thích ngoài JSON) theo đúng cấu trúc sau:
{
  "top": {
    "item": "Tên áo kèm màu sắc hoặc chất liệu",
    "fromWardrobe": true,
    "reason": "Lý do chọn món áo này"
  },
  "bottom": {
    "item": "Tên quần hoặc váy",
    "fromWardrobe": true,
    "reason": "Lý do chọn món này"
  },
  "shoes": {
    "item": "Tên giày dép phù hợp",
    "fromWardrobe": true
  },
  "accessories": ["Phụ kiện 1", "Phụ kiện 2"],
  "colorPalette": ["#1E293B", "#3B82F6", "#FFFFFF"],
  "stylingTip": "Mẹo mặc đẹp súc tích cho dịp này",
  "missingItemSuggestion": "Gợi ý 1 món đồ nên sắm thêm để nâng cấp tủ đồ"
}

Quy tắc:
- Nếu onlyUseWardrobe là true và trong tủ có món phù hợp, đặt fromWardrobe = true và chọn đúng tên món trong tủ đồ.
- colorPalette phải có 3 mã màu HEX hoặc tên màu chủ đạo hài hòa.
`;

    const userPrompt = `
Thông tin người dùng:
- Giới tính: ${gender}
- Thời tiết: ${weather}
- Dịp / Hoạt động: ${occasion}
- Phong cách ưu tiên: ${stylePreference}
- Yêu cầu chỉ phối từ tủ đồ có sẵn: ${onlyUseWardrobe ? 'CÓ (Ưu tiên tối đa đồ trong tủ)' : 'Linh hoạt'}

DANH SÁCH MÓN ĐỒ TRONG TỦ ĐỒ CỦA KHÁCH:
${wardrobeDescription}
`;

    const resultData = await callGroq({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      jsonMode: true,
      temperature: 0.6,
      max_tokens: 1200
    });

    // Ghi nhận lượt dùng AI vào database
    if (userEmail) {
      const today = new Date().toISOString().slice(0, 10);
      incrementAIUsage(userEmail, today);
    }

    const formattedData = formatBackendOutfit(resultData, { occasion, weather, wardrobeItems });
    return res.json({ success: true, data: formattedData, engine: 'groq' });

  } catch (error) {
    console.error("Lỗi khi gọi Groq AI Stylist:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Không thể tạo gợi ý phối đồ từ Groq lúc này. Vui lòng thử lại!"
    });
  }
});

// ==========================================
// ENDPOINT 2: AI NUTRITIONIST & PT (DÙNG GROQ LPU)
// ==========================================
app.post('/api/recommend-fitness', async (req, res) => {
  try {
    if (!checkGroqClient(res)) return;

    const {
      gender = 'Nam',
      height = 170,
      weight = 65,
      goal = 'Giảm mỡ tăng cơ',
      dietPreference = 'Ăn sạch (Eat Clean), món Việt',
      budget = 'Tiêu chuẩn',
      workoutLocation = 'Tại nhà không dụng cụ',
      durationMinutes = 30,
      userEmail = ''
    } = req.body;

    const systemPrompt = `
Bạn là Huấn luyện viên Thể hình (PT) & Chuyên gia Dinh dưỡng Thể thao.
Hãy lập 1 kế hoạch ăn uống và luyện tập trong ngày tối ưu.
BẮT BUỘC trả về duy nhất 1 JSON object hợp lệ (không kèm markdown ngoài JSON) theo đúng cấu trúc sau:
{
  "healthMetrics": {
    "bmi": 22.5,
    "bmiStatus": "Cân đối",
    "targetCalories": 2100,
    "waterIntakeLiters": 2.6
  },
  "meals": {
    "breakfast": {
      "name": "Tên món ăn sáng Việt Nam kèm định lượng",
      "calories": 450,
      "macros": "25g Protein / 50g Carb / 12g Fat"
    },
    "lunch": {
      "name": "Tên món ăn trưa Việt Nam kèm định lượng",
      "calories": 700,
      "macros": "40g Protein / 70g Carb / 18g Fat"
    },
    "dinner": {
      "name": "Tên món ăn tối Việt Nam kèm định lượng",
      "calories": 600,
      "macros": "35g Protein / 55g Carb / 14g Fat"
    },
    "snack": {
      "name": "Tên món bữa phụ lành mạnh",
      "calories": 200
    }
  },
  "shoppingList": [
    "Nguyên liệu 1 kèm khối lượng",
    "Nguyên liệu 2 kèm khối lượng",
    "Nguyên liệu 3 kèm khối lượng",
    "Nguyên liệu 4 kèm khối lượng"
  ],
  "workout": {
    "focusArea": "Chủ đề buổi tập",
    "durationMinutes": 30,
    "exercises": [
      {
        "name": "Tên bài tập",
        "sets": 3,
        "reps": "12-15 lần",
        "restSeconds": 60,
        "tip": "Mẹo tư thế hoặc nhịp thở"
      }
    ]
  }
}

Quy tắc:
- BMI = weight / ((height/100)^2) làm tròn 1 chữ số thập phân.
- Món ăn ưu tiên 100% món ăn Việt Nam gần gũi theo ngân sách '${budget}'.
- Bài tập phải khớp địa điểm '${workoutLocation}'.
`;

    const userPrompt = `
Thông tin thể trạng khách hàng:
- Giới tính: ${gender} | Chiều cao: ${height} cm | Cân nặng: ${weight} kg
- Mục tiêu thể hình: ${goal}
- Chế độ ăn: ${dietPreference}
- Ngân sách đi chợ / ngày: ${budget}
- Địa điểm tập luyện: ${workoutLocation}
- Thời gian tập: ${durationMinutes} phút
`;

    const resultData = await callGroq({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      jsonMode: true,
      temperature: 0.6,
      max_tokens: 1400
    });

    // Ghi nhận lượt dùng AI vào database
    if (userEmail) {
      const today = new Date().toISOString().slice(0, 10);
      incrementAIUsage(userEmail, today);
    }

    const formattedData = formatBackendFitness(resultData, { goal, dietPreference, durationMinutes, targetCalories: 2000 });
    return res.json({ success: true, data: formattedData, engine: 'groq' });

  } catch (error) {
    console.error("Lỗi khi gọi Groq AI Fitness:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Không thể tạo kế hoạch ăn uống và tập luyện từ Groq lúc này. Vui lòng thử lại!"
    });
  }
});

// Kiểm tra trạng thái server
app.get('/', (req, res) => {
  res.json({
    name: 'Wearwell Backend API & Database',
    status: 'online',
    aiEngine: 'Groq Cloud LPU',
    model: groqModel,
    database: 'SQLite & File Storage active',
    uploads: 'Active at /uploads'
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend Wearwell (Groq AI) đang chạy tại http://localhost:${PORT}`);
  console.log(`⚡ AI Engine: Groq (${groqModel})`);
  console.log(`📁 Thư mục lưu ảnh: ${path.join(__dirname, 'uploads')}`);
});
