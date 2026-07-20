import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ReadonlySessionManager,
} from "@oh-my-pi/pi-coding-agent";
import rewindExtension from "../src/index.js";
import {
  handleForkRestore,
  resolveCheckpointAtOrBefore,
  registerCommands,
} from "../src/commands.js";
import {
  createCheckpoint,
  git,
  listCheckpointRefs,
  type CheckpointData,
} from "../src/core.js";
import {
  createInitialState,
  runRepositoryOperation,
  type RewindState,
} from "../src/state.js";

let passed = 0;
let failed = 0;
const errors: string[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function test(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`  FAIL ${name}: ${message}`);
    console.log(`  FAIL ${name}: ${message}`);
  }
}

async function createTempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-rewind-command-test-"));
  await git("init", root);
  await git('config user.email "test@test.com"', root);
  await git('config user.name "Test"', root);
  await writeFile(join(root, "tracked.txt"), "initial\n");
  await git("add tracked.txt", root);
  await git('commit -m "initial"', root);
  return root;
}

interface FakeEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  message?: { role: string };
}

function createSessionManager(
  entries: FakeEntry[],
  leafId: string | null,
  sessionId = "command-session",
): ReadonlySessionManager {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const manager = {
    getSessionId: () => sessionId,
    getLeafId: () => leafId,
    getEntry: (id: string) => byId.get(id),
    getBranch: (fromId?: string) => {
      const branch: FakeEntry[] = [];
      let current = byId.get(fromId ?? leafId ?? "");
      while (current) {
        branch.push(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return branch.reverse();
    },
  };
  // The fake implements the exact ReadonlySessionManager methods exercised here.
  return manager as unknown as ReadonlySessionManager;
}

type Selection = string | ((options: string[]) => string | undefined) | undefined;

class FakeUI {
  readonly selections: Selection[];
  readonly confirms: boolean[];
  readonly selectionOptions: string[][] = [];
  readonly notifications: Array<{ message: string; level: string }> = [];

  constructor(selections: Selection[] = [], confirms: boolean[] = []) {
    this.selections = [...selections];
    this.confirms = [...confirms];
  }
  readonly theme = {
    fg: (_tone: string, text: string) => text,
  };
  readonly statuses = new Map<string, string | undefined>();

  async select<T extends string>(_title: string, options: T[]): Promise<T | undefined> {
    this.selectionOptions.push([...options]);
    const response = this.selections.shift();
    const selected = typeof response === "function" ? response([...options]) : response;
    return selected as T | undefined;
  }

  async confirm(_title: string, _message: string): Promise<boolean> {
    return this.confirms.shift() ?? true;
  }

  notify(message: string, level: string): void {
    this.notifications.push({ message, level });
  }

  setStatus(key: string, value: string | undefined): void {
    this.statuses.set(key, value);
  }
}

function createContext(
  root: string,
  sessionManager: ReadonlySessionManager,
  ui: FakeUI,
  navigateTree: (id: string) => Promise<{ cancelled: boolean }> = async () => ({ cancelled: false }),
): ExtensionCommandContext {
  const context = {
    cwd: root,
    hasUI: true,
    ui,
    sessionManager,
    navigateTree,
  };
  // The command only consumes this tested subset of ExtensionCommandContext.
  return context as unknown as ExtensionCommandContext;
}

interface RegisteredCommand {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
}

function registerRewind(state: RewindState): RegisteredCommand {
  let registered: RegisteredCommand | undefined;
  const api = {
    registerCommand: (_name: string, command: RegisteredCommand) => {
      registered = command;
    },
  };
  // registerCommands only calls registerCommand on this focused fake.
  registerCommands(api as unknown as ExtensionAPI, state);
  if (!registered) throw new Error("rewind command was not registered");
  return registered;
}

function readyState(root: string, sessionId = "command-session"): RewindState {
  const state = createInitialState();
  state.gitAvailable = true;
  state.repoRoot = root;
  state.sessionId = sessionId;
  return state;
}

function checkpointStub(id: string, leafId: string, timestamp: number): CheckpointData {
  return {
    id,
    sessionId: "command-session",
    trigger: "turn",
    turnIndex: 0,
    branch: "main",
    headSha: "0".repeat(40),
    indexTreeSha: "1".repeat(40),
    worktreeTreeSha: "2".repeat(40),
    timestamp,
    conversationLeafId: leafId,
  };
}

async function runTests(): Promise<void> {
  console.log("\nomp-rewind command tests\n");

  await test("exact ancestry resolution and fork user-parent semantics", async () => {
    const entries: FakeEntry[] = [
      { id: "root", parentId: null, type: "message", timestamp: "2026-01-01", message: { role: "assistant" } },
      { id: "a", parentId: "root", type: "message", timestamp: "2026-01-02", message: { role: "assistant" } },
      { id: "a-user", parentId: "a", type: "message", timestamp: "2026-01-03", message: { role: "user" } },
      { id: "b", parentId: "root", type: "message", timestamp: "2026-01-02", message: { role: "assistant" } },
    ];
    const manager = createSessionManager(entries, "a-user");
    const checkpoints = [
      checkpointStub("root-cp", "root", 10),
      checkpointStub("a-z", "a", 20),
      checkpointStub("a-a", "a", 20),
      checkpointStub("sibling", "b", 20),
    ];
    const resolved = resolveCheckpointAtOrBefore(checkpoints, "a-user", manager);
    assertEqual(resolved?.id, "a-a", "deepest exact leaf with deterministic ID tie-break");

    const root = await createTempRepo();
    try {
      const state = readyState(root);
      state.checkpoints.set("user-only", checkpointStub("user-only", "a-user", 30));
      const ui = new FakeUI(["Conversation only (keep files)"]);
      const context = createContext(root, manager, ui);
      await handleForkRestore(state, { entryId: "a-user" }, context);
      assert(
        !ui.selectionOptions[0]?.includes("Restore all (files + conversation)"),
        "normal user branch resolves against parent and excludes user-leaf checkpoint",
      );

      const rootUserEntries: FakeEntry[] = [
        { id: "first-user", parentId: null, type: "message", timestamp: "2026-01-01", message: { role: "user" } },
      ];
      const rootUserManager = createSessionManager(rootUserEntries, "first-user");
      const rootUserState = readyState(root);
      rootUserState.resumeCheckpoint = {
        ...checkpointStub("resume", "unrelated", 10),
        trigger: "resume",
      };
      const rootUserUi = new FakeUI(["Conversation only (keep files)"]);
      await handleForkRestore(
        rootUserState,
        { entryId: "first-user" },
        createContext(root, rootUserManager, rootUserUi),
      );
      assert(
        rootUserUi.selectionOptions[0]?.includes("Restore all (files + conversation)"),
        "root user branch falls back to the session-start checkpoint",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("legacy checkpoint offers files-only and never navigates", async () => {
    const root = await createTempRepo();
    try {
      const state = readyState(root);
      const legacy = await createCheckpoint({
        root,
        id: "legacy-command",
        sessionId: "command-session",
        trigger: "turn",
        turnIndex: 1,
        description: "legacy marker",
      });
      state.checkpoints.set(legacy.id, legacy);
      await writeFile(join(root, "tracked.txt"), "changed\n");
      const ui = new FakeUI([
        (options) => options.find((option) => option.includes("legacy marker")),
        "Files only (keep conversation)",
      ], [true]);
      let navigations = 0;
      const manager = createSessionManager([], null);
      const context = createContext(root, manager, ui, async () => {
        navigations++;
        return { cancelled: false };
      });
      await registerRewind(state).handler("", context);

      assertEqual(navigations, 0, "legacy restore does not navigate conversation");
      assertEqual(
        ui.selectionOptions[1]?.join("|"),
        "Files only (keep conversation)|Cancel",
        "legacy restore modes",
      );
      assert(
        ui.notifications.some((notice) =>
          notice.message === "Conversation restore unavailable: checkpoint predates exact session IDs."),
        "legacy warning emitted",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("file restore failure rolls back once without success or navigation", async () => {
    const root = await createTempRepo();
    try {
      const entries: FakeEntry[] = [
        { id: "leaf", parentId: null, type: "message", timestamp: "2026-01-01", message: { role: "assistant" } },
      ];
      const manager = createSessionManager(entries, "leaf");
      const state = readyState(root);
      const valid = await createCheckpoint({
        root,
        id: "invalid-target-ref",
        sessionId: "command-session",
        trigger: "turn",
        turnIndex: 1,
        description: "invalid target",
        conversationLeafId: "leaf",
        conversationLeafParentId: null,
      });
      const invalid = { ...valid, worktreeTreeSha: "f".repeat(40) };
      state.checkpoints.set(invalid.id, invalid);
      const priorUndo = await createCheckpoint({
        root,
        id: "prior-undo",
        sessionId: "command-session",
        trigger: "before-restore",
        turnIndex: 0,
        restoreTargetId: "older-target",
        conversationLeafId: "leaf",
        conversationLeafParentId: null,
      });
      state.undoCheckpoint = priorUndo;
      await writeFile(join(root, "tracked.txt"), "dirty current\n");
      const currentBytes = await readFile(join(root, "tracked.txt"), "utf-8");
      const ui = new FakeUI([
        (options) => options.find((option) => option.includes("invalid target")),
        "Restore all (files + conversation)",
      ], [true]);
      let navigations = 0;
      const context = createContext(root, manager, ui, async () => {
        navigations++;
        return { cancelled: false };
      });
      await registerRewind(state).handler("", context);

      assertEqual(await readFile(join(root, "tracked.txt"), "utf-8"), currentBytes, "rollback bytes");
      assertEqual(state.undoCheckpoint?.id, priorUndo.id, "prior undo remains authoritative");
      assertEqual(navigations, 0, "navigation not attempted after file failure");
      assertEqual(
        ui.notifications.filter((notice) => notice.level === "error").length,
        1,
        "one error notification",
      );
      assert(
        !ui.notifications.some((notice) => notice.level === "info" && notice.message.startsWith("Rewound")),
        "no success notification",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("real command restores trees without moving HEAD or branch refs", async () => {
    const root = await createTempRepo();
    try {
      const entries: FakeEntry[] = [
        { id: "smoke-leaf", parentId: null, type: "message", timestamp: "2026-01-01", message: { role: "assistant" } },
      ];
      const manager = createSessionManager(entries, "smoke-leaf");
      const state = readyState(root);
      await writeFile(join(root, "tracked.txt"), "checkpoint staged\n");
      await git("add tracked.txt", root);
      await writeFile(join(root, "tracked.txt"), "checkpoint worktree\n");
      const target = await createCheckpoint({
        root,
        id: "head-smoke-target",
        sessionId: "command-session",
        trigger: "turn",
        turnIndex: 1,
        description: "head smoke target",
        conversationLeafId: "smoke-leaf",
        conversationLeafParentId: null,
      });
      state.checkpoints.set(target.id, target);

      await writeFile(join(root, "tracked.txt"), "newer commit\n");
      await git("add tracked.txt", root);
      await git('commit -m "newer branch tip"', root);
      const headBefore = await git("rev-parse HEAD", root);
      const branchBefore = await git("symbolic-ref -q HEAD", root);
      const branchTipBefore = await git(`rev-parse ${branchBefore}`, root);
      const ui = new FakeUI([
        (options) => options.find((option) => option.includes("head smoke target")),
        "Files only (keep conversation)",
      ], [true]);

      await registerRewind(state).handler("", createContext(root, manager, ui));

      assertEqual(
        await readFile(join(root, "tracked.txt"), "utf-8"),
        "checkpoint worktree\n",
        "checkpoint worktree bytes",
      );
      assertEqual(await git("write-tree", root), target.indexTreeSha, "checkpoint index tree");
      assertEqual(await git("rev-parse HEAD", root), headBefore, "HEAD remains at newer commit");
      assertEqual(await git("symbolic-ref -q HEAD", root), branchBefore, "symbolic branch unchanged");
      assertEqual(
        await git(`rev-parse ${branchBefore}`, root),
        branchTipBefore,
        "branch tip remains at newer commit",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("all-mode navigation cancellation restores pre-command worktree and index", async () => {
    const root = await createTempRepo();
    try {
      const entries: FakeEntry[] = [
        { id: "target-leaf", parentId: null, type: "message", timestamp: "2026-01-01", message: { role: "assistant" } },
      ];
      const manager = createSessionManager(entries, "target-leaf");
      const state = readyState(root);
      await writeFile(join(root, "tracked.txt"), "checkpoint staged\n");
      await git("add tracked.txt", root);
      await writeFile(join(root, "tracked.txt"), "checkpoint worktree\n");
      const target = await createCheckpoint({
        root,
        id: "cancel-target",
        sessionId: "command-session",
        trigger: "turn",
        turnIndex: 1,
        description: "cancel target",
        conversationLeafId: "target-leaf",
        conversationLeafParentId: null,
      });
      state.checkpoints.set(target.id, target);
      await writeFile(join(root, "tracked.txt"), "current staged\n");
      await git("add tracked.txt", root);
      await writeFile(join(root, "tracked.txt"), "current worktree\n");
      const bytesBefore = await readFile(join(root, "tracked.txt"), "utf-8");
      const indexBefore = await git("write-tree", root);
      const ui = new FakeUI([
        (options) => options.find((option) => option.includes("cancel target")),
        "Restore all (files + conversation)",
      ], [true]);
      const navigated: string[] = [];
      const context = createContext(root, manager, ui, async (id) => {
        navigated.push(id);
        return { cancelled: true };
      });
      await registerRewind(state).handler("", context);

      assertEqual(navigated.join(","), "target-leaf", "navigation uses stored leaf ID");
      assertEqual(await readFile(join(root, "tracked.txt"), "utf-8"), bytesBefore, "worktree rolled back");
      assertEqual(await git("write-tree", root), indexBefore, "index rolled back");
      assertEqual(state.undoCheckpoint, null, "cancelled all-mode does not commit undo point");
      assert(
        !ui.notifications.some((notice) => notice.level === "info" && notice.message.startsWith("Rewound")),
        "cancelled navigation has no success notification",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("undo consumes its ref only after success and remains after failure", async () => {
    const root = await createTempRepo();
    try {
      const manager = createSessionManager([], null);
      const state = readyState(root);
      const undo = await createCheckpoint({
        root,
        id: "undo-success",
        sessionId: "command-session",
        trigger: "before-restore",
        turnIndex: 0,
        restoreTargetId: "target",
      });
      state.undoCheckpoint = undo;
      await writeFile(join(root, "tracked.txt"), "after rewind\n");
      const ui = new FakeUI(["↩ Undo last rewind"], [true]);
      await registerRewind(state).handler("", createContext(root, manager, ui));
      assertEqual(state.undoCheckpoint, null, "successful undo clears state");
      assert(!(await listCheckpointRefs(root)).includes(undo.id), "successful undo consumes ref");

      const retryable = await createCheckpoint({
        root,
        id: "undo-failure",
        sessionId: "command-session",
        trigger: "before-restore",
        turnIndex: 0,
        restoreTargetId: "target",
      });
      state.undoCheckpoint = { ...retryable, worktreeTreeSha: "e".repeat(40) };
      await writeFile(join(root, "tracked.txt"), "retry current\n");
      const failureUi = new FakeUI(["↩ Undo last rewind"], [true]);
      await registerRewind(state).handler("", createContext(root, manager, failureUi));
      assertEqual(state.undoCheckpoint?.id, retryable.id, "failed undo remains available");
      assert((await listCheckpointRefs(root)).includes(retryable.id), "failed undo ref retained");
      assertEqual(
        failureUi.notifications.filter((notice) => notice.level === "error").length,
        1,
        "failed undo emits one error",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("session restart recovers newest linked undo and excludes restore refs from picker", async () => {
    const root = await createTempRepo();
    try {
      const entries: FakeEntry[] = [
        { id: "restart-leaf", parentId: null, type: "message", timestamp: "2026-01-01", message: { role: "assistant" } },
      ];
      const manager = createSessionManager(entries, "restart-leaf", "restart-session");
      await createCheckpoint({
        root,
        id: "restart-ordinary",
        sessionId: "restart-session",
        trigger: "turn",
        turnIndex: 1,
        description: "ordinary marker",
        conversationLeafId: "restart-leaf",
        conversationLeafParentId: null,
      });
      const older = await createCheckpoint({
        root,
        id: "restart-undo-old",
        sessionId: "restart-session",
        trigger: "before-restore",
        turnIndex: 0,
        description: "BEFORE-MARKER",
        restoreTargetId: "restart-ordinary",
        conversationLeafId: "restart-leaf",
        conversationLeafParentId: null,
      });
      const newest = await createCheckpoint({
        root,
        id: "restart-undo-new",
        sessionId: "restart-session",
        trigger: "before-restore",
        turnIndex: 0,
        description: "BEFORE-MARKER",
        restoreTargetId: "restart-ordinary",
        conversationLeafId: "restart-leaf",
        conversationLeafParentId: null,
      });
      const unlinked = await createCheckpoint({
        root,
        id: "restart-unlinked",
        sessionId: "restart-session",
        trigger: "before-restore",
        turnIndex: 0,
        description: "BEFORE-MARKER",
        conversationLeafId: "restart-leaf",
        conversationLeafParentId: null,
      });

      const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
      let command: RegisteredCommand | undefined;
      const api = {
        on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => {
          handlers.set(name, handler);
        },
        registerCommand: (_name: string, registered: RegisteredCommand) => {
          command = registered;
        },
      };
      // The extension uses only on/registerCommand during registration.
      rewindExtension(api as unknown as ExtensionAPI);
      const ui = new FakeUI([undefined]);
      const context = createContext(root, manager, ui);
      const startHandler = handlers.get("session_start");
      if (!startHandler || !command) throw new Error("extension handlers were not registered");
      await startHandler({}, context);

      const refs = await listCheckpointRefs(root);
      assert(refs.includes(newest.id), "newest linked undo recovered");
      assert(!refs.includes(older.id), "older linked undo deleted");
      assert(!refs.includes(unlinked.id), "unlinked current-session ref deleted");
      await command.handler("", context);
      assert(ui.selectionOptions[0]?.includes("↩ Undo last rewind"), "undo action reconstructed");
      assert(
        !ui.selectionOptions[0]?.some((option) => option.includes("BEFORE-MARKER")),
        "before-restore refs excluded from picker",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("repository operations execute FIFO after rejection", async () => {
    const state = createInitialState();
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const first = runRepositoryOperation(state, async () => {
      order.push("first-start");
      markFirstStarted();
      await firstGate;
      order.push("first-end");
      throw new Error("expected rejection");
    });
    const second = runRepositoryOperation(state, async () => {
      order.push("second");
      return 2;
    });
    await firstStarted;
    assertEqual(order.join("|"), "first-start", "second waits behind first");
    releaseFirst();
    await first.catch(() => undefined);
    assertEqual(await second, 2, "second result");
    assertEqual(order.join("|"), "first-start|first-end|second", "FIFO order");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (errors.length > 0) {
    console.log("Failures:");
    errors.forEach((error) => console.log(error));
  }
  process.exit(failed > 0 ? 1 : 0);
}

await runTests();
