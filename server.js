require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const { Pool } = require('pg');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── 미들웨어 ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── PostgreSQL 연결 풀 ──────────────────────────────────
// 우선순위: DATABASE_URL > PGHOST(Railway 자동) > DB_HOST(로컬)
function createPool() {
  if (process.env.DATABASE_URL) {
    console.log('🔗 연결 방식: DATABASE_URL');
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  if (process.env.PGHOST) {
    console.log('🔗 연결 방식: PGHOST (Railway 자동 변수)');
    return new Pool({
      host:     process.env.PGHOST,
      port:     parseInt(process.env.PGPORT)    || 5432,
      user:     process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      ssl: { rejectUnauthorized: false },
    });
  }
  console.log('🔗 연결 방식: 로컬 DB_HOST');
  return new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 5432,
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME     || 'comment_board',
  });
}
const pool = createPool();

// ─── DB 초기화 (테이블 자동 생성) ────────────────────────
async function initDB() {
  // 연결 정보 진단 로그 (비밀번호 제외)
  console.log('🔍 DATABASE_URL:', !!process.env.DATABASE_URL);
  console.log('🔍 PGHOST:', process.env.PGHOST || '(없음)');
  console.log('🔍 DB_HOST:', process.env.DB_HOST || '(없음)');

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id           SERIAL PRIMARY KEY,
        name         VARCHAR(50)  NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        content      TEXT         NOT NULL,
        created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ DB 연결 성공 & 테이블 준비 완료');
  } catch (err) {
    console.error('❌ DB 초기화 실패 상세:', err.message);
    console.error('❌ 에러 코드:', err.code);
    console.error('❌ 전체 에러:', err);
    process.exit(1);
  }
}

// ─── API 라우터 ──────────────────────────────────────────

/**
 * GET /api/comments
 * 모든 댓글 조회 (최신순)
 */
app.get('/api/comments', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, content, created_at FROM comments ORDER BY created_at DESC'
    );
    res.json({ ok: true, comments: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: '서버 오류가 발생했습니다.' });
  }
});

/**
 * POST /api/comments
 * 댓글 등록
 * body: { name, password, content }
 */
app.post('/api/comments', async (req, res) => {
  const { name, password, content } = req.body;

  // 유효성 검사
  if (!name || name.trim().length === 0)
    return res.status(400).json({ ok: false, message: '이름을 입력해주세요.' });
  if (!password || password.length < 4)
    return res.status(400).json({ ok: false, message: '비밀번호는 4자 이상 입력해주세요.' });
  if (!content || content.trim().length === 0)
    return res.status(400).json({ ok: false, message: '댓글 내용을 입력해주세요.' });
  if (name.trim().length > 50)
    return res.status(400).json({ ok: false, message: '이름은 50자 이내로 입력해주세요.' });
  if (content.trim().length > 2000)
    return res.status(400).json({ ok: false, message: '댓글은 2000자 이내로 입력해주세요.' });

  try {
    // 비밀번호 bcrypt 해싱 (salt rounds: 10)
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO comments (name, password_hash, content)
       VALUES ($1, $2, $3)
       RETURNING id, name, content, created_at`,
      [name.trim(), passwordHash, content.trim()]
    );

    res.status(201).json({ ok: true, comment: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: '서버 오류가 발생했습니다.' });
  }
});

/**
 * DELETE /api/comments/:id
 * 댓글 삭제 (비밀번호 검증)
 * body: { password }
 */
app.delete('/api/comments/:id', async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

  if (!password)
    return res.status(400).json({ ok: false, message: '비밀번호를 입력해주세요.' });
  if (isNaN(parseInt(id)))
    return res.status(400).json({ ok: false, message: '잘못된 요청입니다.' });

  try {
    // 댓글 조회
    const result = await pool.query(
      'SELECT id, password_hash FROM comments WHERE id = $1',
      [parseInt(id)]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ ok: false, message: '댓글을 찾을 수 없습니다.' });

    // 비밀번호 검증
    const isMatch = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!isMatch)
      return res.status(401).json({ ok: false, message: '비밀번호가 올바르지 않습니다.' });

    // 삭제
    await pool.query('DELETE FROM comments WHERE id = $1', [parseInt(id)]);
    res.json({ ok: true, message: '댓글이 삭제되었습니다.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─── SPA fallback (index.html 서빙) ─────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── 서버 시작 ───────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 서버 실행 중: http://localhost:${PORT}`);
  });
});
