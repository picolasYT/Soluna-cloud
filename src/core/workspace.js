import { resolve, relative, isAbsolute, sep } from "node:path";
import { realpath } from "node:fs/promises";

/**
 * Workspace boundary enforcement.
 *
 * The system prompt tells the agent to stay inside the working directory, but
 * a prompt is a request, not a guarantee. A confused model, a prompt-injected
 * file, or a plain mistake can produce `../../../etc/hosts`. This module makes
 * the boundary an actual rule.
 *
 * Two checks, because either alone is insufficient:
 *
 *   1. Lexical  — resolve the path and verify it stays under the root. This
 *      catches `../` traversal and absolute paths.
 *   2. Physical — resolve symlinks with realpath and check again. A symlink
 *      inside the workspace can point anywhere, so the lexical check alone
 *      can be bypassed.
 *
 * Extra directories can be allowed explicitly with --add-dir.
 */

export class WorkspaceError extends Error {
  constructor(message, path) {
    super(message);
    this.name = "WorkspaceError";
    this.path = path;
    this.code = "OUTSIDE_WORKSPACE";
  }
}

/** Windows file systems are case-insensitive: `C:\\Users` and `c:\\users` are the same place. */
function fold(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** True when `child` is inside `parent` (or is `parent` itself). */
export function isInside(parent, child) {
  const rel = relative(fold(parent), fold(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Guards filesystem access for one session.
 */
export class Workspace {
  /**
   * @param {string}   root          The working directory
   * @param {object}   options
   * @param {string[]} [options.allow]   Extra readable/writable roots
   * @param {boolean}  [options.unsafe]  Disable enforcement entirely
   */
  constructor(root, options = {}) {
    this.root = resolve(root);
    this.allowed = [this.root, ...(options.allow || []).map((d) => resolve(d))];
    this.unsafe = Boolean(options.unsafe);
    /** Cache of realpath(root) per allowed root, filled lazily. */
    this._realRoots = new Map();
  }

  /**
   * Physical (symlink-resolved) form of every allowed root. A root reached
   * through a symlink (Termux's ~/storage, macOS /tmp, a Windows junction)
   * would otherwise make every file inside it look like an escape.
   */
  async #realRoots() {
    const out = [];
    for (const dir of this.allowed) {
      if (!this._realRoots.has(dir)) {
        try {
          this._realRoots.set(dir, await realpath(dir));
        } catch {
          this._realRoots.set(dir, dir);
        }
      }
      out.push(this._realRoots.get(dir));
    }
    return out;
  }

  /** Every root this workspace can touch. */
  get roots() {
    return [...this.allowed];
  }

  /** Add another permitted root at runtime. */
  allowDirectory(dir) {
    const abs = resolve(dir);
    if (!this.allowed.includes(abs)) this.allowed.push(abs);
    return abs;
  }

  /**
   * Change the active working root (e.g. the /cwd command in the TUI).
   * Only allowed when the target is already inside the workspace.
   */
  chdir(dir) {
    const abs = resolve(dir);
    if (!this.unsafe && !this.#withinAllowed(abs)) {
      throw new WorkspaceError(
        `Cannot change directory to "${dir}": it is outside the workspace (${this.root}). ` +
          `Start Soluna there, or pass --add-dir to allow it.`,
        abs,
      );
    }
    this.root = abs;
    return abs;
  }

  /** Lexical containment check against every allowed root. */
  #withinAllowed(absolutePath) {
    return this.allowed.some((rootDir) => isInside(rootDir, absolutePath));
  }

  /**
   * Resolve a user-supplied path and verify it stays inside the workspace.
   *
   * @param {string} inputPath
   * @param {object} [options]
   * @param {boolean} [options.mustExist] Follow symlinks on the path itself
   * @returns {Promise<string>} the absolute, verified path
   * @throws {WorkspaceError}
   */
  async resolvePath(inputPath, { mustExist = false } = {}) {
    if (typeof inputPath !== "string" || inputPath.trim() === "") {
      throw new WorkspaceError("Path must be a non-empty string", inputPath);
    }

    const absolute = isAbsolute(inputPath) ? resolve(inputPath) : resolve(this.root, inputPath);

    if (this.unsafe) return absolute;

    if (!this.#withinAllowed(absolute)) {
      throw new WorkspaceError(
        `Refusing to touch "${inputPath}": it resolves outside the workspace ` +
          `(${this.root}). Start Soluna there, or pass --add-dir to allow it.`,
        absolute,
      );
    }

    // Symlinks can point anywhere, so re-check the physical path. When the
    // target does not exist yet we check its nearest existing ancestor,
    // which is what matters for a create.
    const physical = await this.#realpathOrAncestor(absolute, mustExist);
    if (physical && !this.#withinAllowed(physical) && !(await this.#realRoots()).some((r) => isInside(r, physical))) {
      throw new WorkspaceError(
        `Refusing to touch "${inputPath}": it is a symlink pointing outside ` +
          `the workspace (${physical}).`,
        physical,
      );
    }

    return absolute;
  }

  /**
   * realpath the target, or the closest existing ancestor when it is missing.
   * Returns null if nothing on the path exists.
   */
  async #realpathOrAncestor(absolutePath, mustExist) {
    try {
      return await realpath(absolutePath);
    } catch (err) {
      if (mustExist || err.code !== "ENOENT") {
        if (err.code === "ENOENT" && mustExist) return null;
        if (err.code !== "ENOENT") return null;
      }
    }

    // Walk up to the first component that exists.
    let current = absolutePath;
    for (let i = 0; i < 64; i++) {
      const parent = resolve(current, "..");
      if (parent === current) return null;
      try {
        return await realpath(parent);
      } catch (err) {
        if (err.code !== "ENOENT") return null;
        current = parent;
      }
    }
    return null;
  }

  /** Human-readable summary for the UI. */
  describe() {
    if (this.unsafe) return "unrestricted (--unsafe)";
    if (this.allowed.length === 1) return this.root;
    return `${this.root} (+${this.allowed.length - 1} allowed)`;
  }
}

/** Shorthand for a workspace rooted at cwd. */
export function createWorkspace(cwd, options = {}) {
  return new Workspace(cwd, options);
}
