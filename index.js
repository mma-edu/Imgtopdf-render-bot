const { Telegraf } = require('telegraf');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const fetch = require('node-fetch');
const express = require('express'); // Added for Render compatibility

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// Enhanced error handling for Render
if (!process.env.BOT_TOKEN) {
  console.error("❌ FATAL: Missing BOT_TOKEN");
  process.exit(1);
}

// Improved session storage with 50-image limit
const userSessions = {};
const MAX_IMAGES_PER_USER = 50;

// Middleware with memory leak protection
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  
  const userId = ctx.from.id;
  if (!userSessions[userId]) {
    userSessions[userId] = { 
      images: [],
      lastActivity: Date.now()
    };
  }
  
  // Auto-clean old sessions (Render has limited memory)
  if (Date.now() - userSessions[userId].lastActivity > 86400000) { // 24h
    delete userSessions[userId];
    return ctx.reply("⌛ Your session expired. Send /start to begin.");
  }
  
  ctx.session = userSessions[userId];
  ctx.session.lastActivity = Date.now();
  await next();
});

// Commands (unchanged from your Vercel version)
bot.command('start', (ctx) => {
  ctx.reply("📸➡️📄 *Image to PDF Bot*\n\nSend me images (JPEG/PNG) and I'll convert them to PDF!\n\n• Max 50 images\n• /convert when ready\n• /cancel to clear", { parse_mode: 'Markdown' });
});

bot.command('help', (ctx) => {
  ctx.reply("🆘 *How to use:*\n1. Send images\n2. Type /convert\n3. Get PDF\n\nMax 50 images", { parse_mode: 'Markdown' });
});

bot.command('cancel', (ctx) => {
  ctx.session.images = [];
  ctx.reply("🗑️ Cleared all images!");
});

// Image processing with Render-specific optimizations
async function processImage(ctx, file) {
  if (ctx.session.images.length >= MAX_IMAGES_PER_USER) {
    return ctx.reply(`⚠️ Maximum ${MAX_IMAGES_PER_USER} images reached. Use /convert now.`);
  }

  try {
    const fileUrl = await ctx.telegram.getFileLink(file.file_id);
    const response = await fetch(fileUrl);
    const imageBuffer = await response.buffer();
    
    // Render-specific: Downscale images to prevent OOM errors
    const processedImage = await sharp(imageBuffer)
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    ctx.session.images.push(processedImage);
    ctx.reply(`✅ Added image (${ctx.session.images.length}/${MAX_IMAGES_PER_USER})`);
  } catch (error) {
    console.error("Image processing failed:", error);
    ctx.reply("❌ Failed to process image. Try another file.");
  }
}

// PDF generation with Render memory constraints
bot.command('convert', async (ctx) => {
  if (!ctx.session.images?.length) {
    return ctx.reply("⚠️ No images to convert");
  }

  ctx.reply("⏳ Creating PDF...");

  try {
    const pdfDoc = new PDFDocument({ margin: 0 });
    const chunks = [];
    let pdfSize = 0;

    pdfDoc.on('data', chunk => {
      chunks.push(chunk);
      pdfSize += chunk.length;
      if (pdfSize > 45 * 1024 * 1024) { // Keep under 50MB
        throw new Error("PDF approaching size limit - stopping early");
      }
    });

    // Process images sequentially to reduce memory pressure
    for (const [index, imgBuffer] of ctx.session.images.entries()) {
      const img = await sharp(imgBuffer)
        .resize(800, 800, { fit: 'inside' })
        .toBuffer();
      
      pdfDoc.image(img, 0, 0, { width: 595, height: 842 }); // A4 size
      if (index < ctx.session.images.length - 1) pdfDoc.addPage();
    }

    const pdfPromise = new Promise((resolve, reject) => {
      pdfDoc.on('end', resolve);
      pdfDoc.on('error', reject);
      pdfDoc.end();
    });

    await pdfPromise;
    const pdfBuffer = Buffer.concat(chunks);

    await ctx.replyWithDocument({
      source: pdfBuffer,
      filename: `images_${Date.now()}.pdf`
    });

    ctx.session.images = [];
  } catch (error) {
    console.error("PDF generation failed:", error);
    ctx.reply(`❌ PDF failed: ${error.message}\nTry with fewer images.`);
  }
});

// Render-required Express setup
app.use(express.json());
app.post(`/webhook`, async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.status(200).end();
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).end();
  }
});

// Health check endpoint for Render monitoring
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    sessions: Object.keys(userSessions).length 
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot running on port ${PORT}`);
  if (process.env.RENDER) {
    console.log("⚡ Render.com detected - webhook mode active");
    // Auto-set webhook on Render
    const webhookUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/webhook`;
    bot.telegram.setWebhook(webhookUrl)
      .then(() => console.log(`Webhook set to ${webhookUrl}`))
      .catch(err => console.error("Webhook setup failed:", err));
  } else {
    console.log("🔌 Development mode - using polling");
    bot.launch();
  }
});

// Clean up on exit
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully');
  bot.stop();
  process.exit(0);
});