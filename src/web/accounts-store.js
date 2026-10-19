import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const scrypt = promisify(scryptCallback);
const digest = (value) => createHash("sha256").update(value).digest("hex");
export const keyFingerprint = (provider, key) => digest(`${provider}\0${key}`);

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${hash.toString("hex")}`;
}

export async function checkPassword(password, encoded) {
  const [format, salt, hex] = String(encoded || "").split("$");
  if (format !== "scrypt" || !/^[a-f0-9]{32}$/.test(salt || "") || !/^[a-f0-9]{128}$/.test(hex || "")) return false;
  const actual = await scrypt(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(hex, "hex"));
}

export function secretBox(master) {
  if (typeof master !== "string" || master.length < 32) throw new Error("Configurá SOLUNA_ENCRYPTION_KEY con al menos 32 caracteres estables en Render.");
  const key = createHash("sha256").update(master).digest();
  return {
    seal(value, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context));
      const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), bytes.toString("base64")].join(":");
    },
    open(encoded, context) {
      const [version, iv, tag, bytes] = String(encoded).split(":");
      if (version !== "v1") throw new Error("Formato de cifrado desconocido.");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(bytes, "base64")), decipher.final()]).toString("utf8"));
    },
  };
}

export const publicUser = (row) => ({ id: row.id, username: row.username, isAdmin: row.is_admin === true && row.username === "picolas", disabled: row.disabled === true, createdAt: row.created_at });

export async function createAccountsStore({ databaseUrl, encryptionKey, pool: suppliedPool } = {}) {
  const box = secretBox(encryptionKey);
  const pool = suppliedPool || new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, enableChannelBinding: true });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS soluna_users (
      id UUID PRIMARY KEY, username VARCHAR(30) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      disabled BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS soluna_logins (
      token_hash CHAR(64) PRIMARY KEY, user_id UUID NOT NULL REFERENCES soluna_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS soluna_logins_expiry ON soluna_logins(expires_at);
    CREATE TABLE IF NOT EXISTS soluna_provider_keys (
      user_id UUID NOT NULL REFERENCES soluna_users(id) ON DELETE CASCADE,
      provider VARCHAR(100) NOT NULL, encrypted_keys TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id, provider)
    );
    CREATE TABLE IF NOT EXISTS soluna_audit (
      id BIGSERIAL PRIMARY KEY, admin_id UUID REFERENCES soluna_users(id),
      target_id UUID REFERENCES soluna_users(id), action VARCHAR(80) NOT NULL,
      provider VARCHAR(100), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const store = {
    async ensureAdmin(password) {
      const existing = await pool.query("SELECT * FROM soluna_users WHERE username=$1", ["picolas"]);
      if (existing.rows[0]) {
        const user = publicUser(existing.rows[0]);
        if (!user.isAdmin || user.disabled) throw new Error("La cuenta picolas existe sin permisos de administrador. Revisá soluna_users en Neon.");
        return user;
      }
      if (typeof password !== "string" || password.length < 10 || password.length > 128) throw new Error("Configurá SOLUNA_ADMIN_PASSWORD (entre 10 y 128 caracteres) o una SOLUNA_WEB_TOKEN válida para crear la cuenta picolas.");
      const result = await pool.query("INSERT INTO soluna_users(id,username,password_hash,is_admin) VALUES($1,$2,$3,TRUE) ON CONFLICT(username) DO NOTHING RETURNING *", [randomUUID(), "picolas", await hashPassword(password)]);
      if (result.rows[0]) return publicUser(result.rows[0]);
      return publicUser((await pool.query("SELECT * FROM soluna_users WHERE username=$1", ["picolas"])).rows[0]);
    },
    async register(username, password) {
      username = String(username || "").trim().toLowerCase();
      if (!/^[a-z0-9_]{3,30}$/.test(username)) throw Object.assign(new Error("Usá entre 3 y 30 letras, números o guion bajo para tu usuario."), { status: 400 });
      if (username === "picolas") throw Object.assign(new Error("Ese nombre está reservado al administrador."), { status: 409 });
      if (typeof password !== "string" || password.length < 10 || password.length > 128) throw Object.assign(new Error("La contraseña debe tener entre 10 y 128 caracteres."), { status: 400 });
      try {
        const result = await pool.query("INSERT INTO soluna_users(id,username,password_hash) VALUES($1,$2,$3) RETURNING *", [randomUUID(), username, await hashPassword(password)]);
        return publicUser(result.rows[0]);
      } catch (error) {
        if (error.code === "23505") throw Object.assign(new Error("Ese usuario ya está registrado."), { status: 409 });
        throw error;
      }
    },
    async login(username, password) {
      const result = await pool.query("SELECT * FROM soluna_users WHERE username=$1", [String(username || "").trim().toLowerCase()]);
      const row = result.rows[0];
      // Do comparable work for an unknown username without storing a plaintext password.
      const hash = row?.password_hash || `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;
      const valid = typeof password === "string" && password.length <= 128 && await checkPassword(password, hash);
      if (!row || !valid || row.disabled) throw Object.assign(new Error("Usuario o contraseña incorrectos."), { status: 401 });
      return publicUser(row);
    },
    async createLogin(userId) {
      const token = randomBytes(32).toString("base64url");
      await pool.query("DELETE FROM soluna_logins WHERE expires_at <= NOW()");
      await pool.query("INSERT INTO soluna_logins(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '7 days')", [digest(token), userId]);
      return token;
    },
    async authenticate(token) {
      if (!token || token.length > 256) return null;
      const result = await pool.query("SELECT u.* FROM soluna_logins l JOIN soluna_users u ON u.id=l.user_id WHERE l.token_hash=$1 AND l.expires_at>NOW() AND u.disabled=FALSE", [digest(token)]);
      return result.rows[0] ? publicUser(result.rows[0]) : null;
    },
    async logout(token) { if (token) await pool.query("DELETE FROM soluna_logins WHERE token_hash=$1", [digest(token)]); },
    async users() { return (await pool.query("SELECT * FROM soluna_users ORDER BY is_admin DESC,created_at")).rows.map(publicUser); },
    async user(id) { const result = await pool.query("SELECT * FROM soluna_users WHERE id=$1", [id]); return result.rows[0] ? publicUser(result.rows[0]) : null; },
    async disable(id, disabled) {
      const result = await pool.query("UPDATE soluna_users SET disabled=$2 WHERE id=$1 AND is_admin=FALSE RETURNING *", [id, disabled]);
      if (!result.rows[0]) throw Object.assign(new Error("No se puede modificar esa cuenta."), { status: 400 });
      if (disabled) await pool.query("DELETE FROM soluna_logins WHERE user_id=$1", [id]);
      return publicUser(result.rows[0]);
    },
    async saveKeys(userId, provider, keys) {
      const encrypted = box.seal(keys, `${userId}:${provider}`);
      await pool.query("INSERT INTO soluna_provider_keys(user_id,provider,encrypted_keys) VALUES($1,$2,$3) ON CONFLICT(user_id,provider) DO UPDATE SET encrypted_keys=$3,updated_at=NOW()", [userId, provider, encrypted]);
    },
    async keySets(userId) {
      const rows = (await pool.query("SELECT * FROM soluna_provider_keys WHERE user_id=$1", [userId])).rows;
      return Object.fromEntries(rows.map((row) => [row.provider, box.open(row.encrypted_keys, `${userId}:${row.provider}`)]));
    },
    async allKeys() {
      const rows = (await pool.query("SELECT k.*,u.username FROM soluna_provider_keys k JOIN soluna_users u ON u.id=k.user_id ORDER BY u.username,k.provider")).rows;
      return rows.flatMap((row) => box.open(row.encrypted_keys, `${row.user_id}:${row.provider}`).map((key, index) => ({ userId: row.user_id, username: row.username, provider: row.provider, id: keyFingerprint(row.provider, key), label: `Clave ${index + 1}`, masked: key.length > 8 ? `•••• ${key.slice(-4)}` : "••••", updatedAt: row.updated_at })));
    },
    async revealKey(userId, provider, id) {
      const keys = (await store.keySets(userId))[provider] || [];
      const key = keys.find((value) => keyFingerprint(provider, value) === id);
      if (!key) throw Object.assign(new Error("La clave ya no existe."), { status: 404 });
      return key;
    },
    async audit(adminId, targetId, action, provider = null) { await pool.query("INSERT INTO soluna_audit(admin_id,target_id,action,provider) VALUES($1,$2,$3,$4)", [adminId, targetId, action, provider]); },
    async close() { if (!suppliedPool) await pool.end(); },
  };
  return store;
}
