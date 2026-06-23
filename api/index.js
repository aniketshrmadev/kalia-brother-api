import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

const app = express();

let cachedDb = null;

async function connectDB() {
  if (cachedDb) return cachedDb;
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    cachedDb = conn;
    return conn;
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    throw error;
  }
}

const sizeSchema = new mongoose.Schema({
  size: { type: String, required: true },
  stock: { type: Number, required: true, default: 0 }
}, { _id: false });

const variantSchema = new mongoose.Schema({
  color: { type: String, required: true },
  colorHex: { type: String, required: true },
  images: [{ type: String }],
  sizes: [sizeSchema]
}, { _id: false });

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: String, required: true, enum: ['T-Shirts', 'Shirts', 'Pants', 'Shorts', 'Watches', 'Belts', 'Perfume', 'Accessories'] },
  description: { type: String, required: true },
  fabric: { type: String, required: true },
  price: { type: Number, required: true },
  isFeatured: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  variants: [variantSchema],
  createdAt: { type: Date, default: Date.now }
});

let Product;
try {
  Product = mongoose.model('Product');
} catch {
  Product = mongoose.model('Product', productSchema);
}

const JWT_SECRET = process.env.JWT_SECRET || 'kalia-brother-secret-key';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@kaliabrother.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'kalia123';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ALLOWED_PRODUCT_FIELDS = ['name', 'category', 'description', 'fabric', 'price', 'isFeatured', 'isActive', 'variants'];

function pickAllowed(obj, allowed) {
  const picked = {};
  for (const key of allowed) {
    if (obj[key] !== undefined) picked[key] = obj[key];
  }
  return picked;
}

function authMiddleware(req, res, next) {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'No token, authorization denied' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ message: 'Token is not valid' });
  }
}

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'https://kalia-brother-client.vercel.app',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));

app.get('/api', (req, res) => {
  res.json({ message: 'Kalia Brother API is running' });
});

app.get('/api/products', async (req, res) => {
  try {
    await connectDB();
    const { category, color, size, minPrice, maxPrice, fabric, sort, search, featured, page = 1, limit = 12 } = req.query;
    let query = { isActive: true };
    if (category) query.category = category;
    if (fabric) query.fabric = fabric;
    if (featured === 'true') query.isFeatured = true;
    if (search) query.name = { $regex: escapeRegex(search), $options: 'i' };
    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = Number(minPrice);
      if (maxPrice) query.price.$lte = Number(maxPrice);
    }
    if (color) query['variants.colorHex'] = color;
    if (size) query['variants.sizes.size'] = size;
    let sortOption = { createdAt: -1 };
    if (sort === 'price-low') sortOption = { price: 1 };
    if (sort === 'price-high') sortOption = { price: -1 };
    const skip = (Number(page) - 1) * Number(limit);
    const products = await Product.find(query).sort(sortOption).skip(skip).limit(Number(limit));
    const total = await Product.countDocuments(query);
    res.json({ products, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/products/all', authMiddleware, async (req, res) => {
  try {
    await connectDB();
    const products = await Product.find().sort({ createdAt: -1 });
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/products/dashboard', authMiddleware, async (req, res) => {
  try {
    await connectDB();
    const totalProducts = await Product.countDocuments();
    const lowStock = await Product.aggregate([
      { $unwind: '$variants' },
      { $unwind: '$variants.sizes' },
      { $match: { 'variants.sizes.stock': { $lt: 5, $gt: 0 } } },
      { $group: { _id: '$_id', name: { $first: '$name' } } },
      { $limit: 10 }
    ]);
    const recentProducts = await Product.find().sort({ createdAt: -1 }).limit(5);
    res.json({ totalProducts, lowStock, recentProducts });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    await connectDB();
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/products', authMiddleware, async (req, res) => {
  try {
    await connectDB();
    const allowed = pickAllowed(req.body, ALLOWED_PRODUCT_FIELDS);
    const product = new Product(allowed);
    const saved = await product.save();
    res.status(201).json(saved);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.put('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    await connectDB();
    const allowed = pickAllowed(req.body, ALLOWED_PRODUCT_FIELDS);
    const product = await Product.findByIdAndUpdate(req.params.id, allowed, { new: true, runValidators: true });
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(product);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    await connectDB();
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json({ message: 'Product deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, email });
  } else {
    res.status(401).json({ message: 'Invalid credentials' });
  }
});

app.get('/api/auth/profile', authMiddleware, (req, res) => {
  res.json({ email: req.admin.email });
});

export default app;
