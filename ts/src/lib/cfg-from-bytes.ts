import { ActionType } from "avm1-types/action-type";
import { Action as CfgAction } from "avm1-types/cfg/action";
import { CatchBlock } from "avm1-types/cfg/catch-block";
import { Cfg } from "avm1-types/cfg/cfg";
import { CfgBlock } from "avm1-types/cfg/cfg-block";
import { CfgFlowType } from "avm1-types/cfg/cfg-flow-type";
import { CfgLabel, NullableCfgLabel } from "avm1-types/cfg/cfg-label";
import { Action as RawAction } from "avm1-types/raw/action";
import { Try } from "avm1-types/raw/actions/try";
import { UintSize } from "semantic-types";
import { Avm1Parser } from "./index";

type IdProvider = () => number;

function createIdProvider(): IdProvider {
  let id: number = 0;
  return () => id++;
}

export function cfgFromBytes(avm1: Uint8Array): Cfg {
  const avm1Parser: Avm1Parser = new Avm1Parser(avm1);
  return parseHardBlock(avm1Parser, 0, avm1.length, createIdProvider());
}

interface SoftBlock {
  id: number;
  actions: Map<UintSize, ParsedAction>;
  outJumps: Set<UintSize>;
  jumpTargets: Set<UintSize>;
  simpleTargets: Map<UintSize, number>;
  endOfActions: Set<UintSize>;
  start: UintSize;
  end: UintSize;
}

interface ParsedAction {
  raw: RawAction;
  endOffset: UintSize;
}

function parseSoftBlock(parser: Avm1Parser, blockStart: UintSize, blockEnd: UintSize, idp: IdProvider): SoftBlock {
  const id: number = idp();
  // Map from start offset to raw action and end offest.
  const parsed: Map<UintSize, ParsedAction> = new Map();
  const outJumps: Set<UintSize> = new Set();
  const openSet: UintSize[] = [blockStart];
  const knownOffsets: Set<UintSize> = new Set(openSet);
  // Offsets that must be labeled because there exists `If` or `Jump` actions
  // jumping to these offsets.
  const jumpTargets: Set<UintSize> = new Set();
  // Offsets that are reached through simple linear control flow, with the
  // associated count. The count is usually 1, except in the case of overlapping
  // linear flow.
  const simpleTargets: Map<UintSize, number> = new Map();
  // Offsets of known `EndOfAction`
  const endOfActions: Set<UintSize> = new Set();

  function incSimpleTarget(target: UintSize): void {
    let old: number | undefined = simpleTargets.get(target);
    if (old === undefined) {
      old = 0;
    }
    simpleTargets.set(target, old + 1);
  }

  while (openSet.length > 0) {
    const curOffset: UintSize = openSet.pop()!;
    if (curOffset < blockStart || curOffset >= blockEnd) {
      outJumps.add(curOffset);
      continue;
    }
    const raw: RawAction | undefined = parser.readAt(curOffset);
    if (raw === undefined) {
      // EndOfActions
      endOfActions.add(curOffset);
      continue;
    }
    const endOffset: UintSize = parser.getBytePos();
    if (endOffset <= curOffset) {
      throw new Error("ExpectedBytePos to advance");
    }

    const nextOffsets: Set<UintSize> = new Set();
    switch (raw.action) {
      case ActionType.DefineFunction:
      case ActionType.DefineFunction2: {
        const afterFn: UintSize = endOffset + raw.bodySize;
        const body: Cfg = parseHardBlock(parser, endOffset, afterFn, idp);
        nextOffsets.add(afterFn);
        parsed.set(curOffset, {raw, body, endOffset} as any);
        incSimpleTarget(afterFn);
        break;
      }
      case ActionType.If: {
        nextOffsets.add(endOffset + raw.offset);
        nextOffsets.add(endOffset);
        parsed.set(curOffset, {raw, endOffset});
        jumpTargets.add(endOffset + raw.offset);
        jumpTargets.add(endOffset);
        break;
      }
      case ActionType.Jump: {
        nextOffsets.add(endOffset + raw.offset);
        parsed.set(curOffset, {raw, endOffset});
        jumpTargets.add(endOffset + raw.offset);
        break;
      }
      case ActionType.Return:
        parsed.set(curOffset, {raw, endOffset});
        break;
      case ActionType.Throw:
        parsed.set(curOffset, {raw, endOffset});
        break;
      case ActionType.Try: {
        const tryStart: UintSize = endOffset;
        const catchStart: UintSize = tryStart + raw.try;
        const finallyStart: UintSize = catchStart + (raw.catch !== undefined ? raw.catch.size : 0);

        let softFinally: SoftBlock | undefined;
        if (raw.finally !== undefined) {
          softFinally = parseSoftBlock(parser, finallyStart, finallyStart + raw.finally, idp);
        }

        const softTry: SoftBlock = parseSoftBlock(parser, tryStart, tryStart + raw.try, idp);

        let softCatch: SoftBlock | undefined;
        if (raw.catch !== undefined) {
          softCatch = parseSoftBlock(parser, catchStart, catchStart + raw.catch.size, idp);
        }

        for (const outJump of softTry.outJumps) {
          nextOffsets.add(outJump);
          jumpTargets.add(outJump);
        }
        if (softCatch !== undefined) {
          for (const outJump of softCatch.outJumps) {
            nextOffsets.add(outJump);
            jumpTargets.add(outJump);
          }
        }
        if (softFinally !== undefined) {
          // Jumps from `try` and `catch` to the start of `finally` are handled as direct jumps
          // to avoid duplication.
          nextOffsets.delete(softFinally.start);
          jumpTargets.delete(softFinally.start);
          for (const outJump of softFinally.outJumps) {
            nextOffsets.add(outJump);
            jumpTargets.add(outJump);
          }
        }
        parsed.set(curOffset, {raw, endOffset, try: softTry, catch: softCatch, finally: softFinally} as any);
        break;
      }
      case ActionType.WaitForFrame:
      case ActionType.WaitForFrame2: {
        const notLoadedOffset: UintSize = parser.skipFrom(endOffset, raw.skip);
        nextOffsets.add(notLoadedOffset);
        nextOffsets.add(endOffset);
        parsed.set(curOffset, {raw, endOffset, notLoadedOffset} as any);
        jumpTargets.add(notLoadedOffset);
        jumpTargets.add(endOffset);
        break;
      }
      case ActionType.With: {
        const withStart: UintSize = endOffset;
        const withEnd: UintSize = withStart + raw.size;
        const inner: SoftBlock = parseSoftBlock(parser, withStart, withEnd, idp);
        for (const outJump of inner.outJumps) {
          nextOffsets.add(outJump);
          jumpTargets.add(outJump);
        }
        parsed.set(curOffset, {raw, endOffset, with: inner} as any);
        break;
      }
      default: {
        nextOffsets.add(endOffset);
        parsed.set(curOffset, {raw, endOffset});
        incSimpleTarget(endOffset);
        break;
      }
    }

    for (const nextOffset of nextOffsets) {
      if (!knownOffsets.has(nextOffset)) {
        knownOffsets.add(nextOffset);
        openSet.push(nextOffset);
      }
    }
  }
  return {
    id,
    actions: parsed,
    outJumps,
    jumpTargets,
    simpleTargets,
    endOfActions,
    start: blockStart,
    end: blockEnd,
  };
}

/**
 *
 * @param soft
 * @param parentLabels `undefined` for hard blocks, or a map of parent labels
 *        for soft blocks.
 */
function resolveLabels(
  soft: SoftBlock,
  parentLabels?: Map<UintSize, CfgLabel | null>,
): Map<UintSize, string | null> {
  function toLabel(offset: number): CfgLabel {
    return `l${soft.id}_${offset}`;
  }

  const offsetToLabel: Map<UintSize, NullableCfgLabel> = new Map();
  for (const offset of soft.actions.keys()) {
    if (soft.jumpTargets.has(offset) || soft.simpleTargets.get(offset) !== 1) {
      offsetToLabel.set(offset, toLabel(offset));
    }
  }
  for (const end of soft.endOfActions) {
    offsetToLabel.set(end, null);
  }
  if (parentLabels === undefined) {
    // hard block
    for (const outJump of soft.outJumps) {
      if (outJump < soft.start) {
        offsetToLabel.set(outJump, toLabel(soft.start));
      }
      if (outJump >= soft.end || soft.endOfActions.has(outJump)) {
        offsetToLabel.set(outJump, null);
      }
    }
  } else {
    // soft block
    for (const outJump of soft.outJumps) {
      const parentLabel: CfgLabel | null | undefined = parentLabels.get(outJump);
      if (parentLabel === undefined) {
        throw new Error("ExpectedOutJumpToExistInParentLabels");
      }
      offsetToLabel.set(outJump, parentLabel);
    }
  }
  offsetToLabel.set(soft.start, toLabel(soft.start));
  const sortedResult: Map<UintSize, string | null> = new Map();
  const sortedOffsets: UintSize[] = [...offsetToLabel.keys()];
  sortedOffsets.sort((a, b) => a - b);
  for (const o of sortedOffsets) {
    sortedResult.set(o, offsetToLabel.get(o)!);
  }
  return sortedResult;
}

function parseHardBlock(parser: Avm1Parser, blockStart: UintSize, blockEnd: UintSize, idp: IdProvider): Cfg {
  const soft: SoftBlock = parseSoftBlock(parser, blockStart, blockEnd, idp);
  const labels: Map<UintSize, string | null> = resolveLabels(soft, undefined);
  return buildCfg(parser, soft, labels, idp, null);
}

function buildCfg(
  parser: Avm1Parser,
  soft: SoftBlock,
  labels: Map<UintSize, string | null>,
  idp: IdProvider,
  defaultNext: NullableCfgLabel | undefined,
): Cfg {
  const blocks: CfgBlock[] = [];
  iterateLabels: for (const [labelOffset, label] of labels) {
    if (label === null || !(soft.start <= labelOffset && labelOffset < soft.end)) {
      continue;
    }
    const actions: CfgAction[] = [];
    let offset: UintSize = labelOffset;
    do {
      if (soft.endOfActions.has(offset)) {
        blocks.push({label, actions, flow: {type: CfgFlowType.Simple, next: null}});
        continue iterateLabels;
      }
      const parsedAction: ParsedAction | undefined = soft.actions.get(offset);
      if (parsedAction === undefined) {
        throw new Error("ExpectedParsedAction");
      }
      switch (parsedAction.raw.action) {
        case ActionType.DefineFunction: {
          const bodyEnd: UintSize = parsedAction.endOffset + parsedAction.raw.bodySize;
          // const cfg: Cfg = parseHardBlock(parser, parsedAction.endOffset, bodyEnd, idp);
          actions.push({
            action: ActionType.DefineFunction,
            name: parsedAction.raw.name,
            parameters: parsedAction.raw.parameters,
            body: (parsedAction as any).body,
          });
          offset = bodyEnd;
          break;
        }
        case ActionType.DefineFunction2: {
          const bodyEnd: UintSize = parsedAction.endOffset + parsedAction.raw.bodySize;
          // const cfg: Cfg = parseHardBlock(parser, parsedAction.endOffset, bodyEnd, idp);
          actions.push({
            action: ActionType.DefineFunction2,
            name: parsedAction.raw.name,
            preloadParent: parsedAction.raw.preloadParent,
            preloadRoot: parsedAction.raw.preloadRoot,
            suppressSuper: parsedAction.raw.suppressSuper,
            preloadSuper: parsedAction.raw.preloadSuper,
            suppressArguments: parsedAction.raw.suppressArguments,
            preloadArguments: parsedAction.raw.preloadArguments,
            suppressThis: parsedAction.raw.suppressThis,
            preloadThis: parsedAction.raw.preloadThis,
            preloadGlobal: parsedAction.raw.preloadGlobal,
            registerCount: parsedAction.raw.registerCount,
            parameters: parsedAction.raw.parameters,
            body: (parsedAction as any).body,
          });
          offset = bodyEnd;
          break;
        }
        case ActionType.End: {
          blocks.push({label, actions, flow: {type: CfgFlowType.Simple, next: null}});
          continue iterateLabels;
        }
        case ActionType.Error: {
          // TODO: Propagate error
          blocks.push({label, actions, flow: {type: CfgFlowType.Error, error: undefined}});
          continue iterateLabels;
        }
        case ActionType.If: {
          const trueTarget: string | null | undefined = labels.get(parsedAction.endOffset + parsedAction.raw.offset);
          if (trueTarget === undefined) {
            throw new Error("ExpectedIfTargetToHaveALabel");
          }
          const falseTarget: string | null | undefined = labels.get(parsedAction.endOffset);
          if (falseTarget === undefined) {
            throw new Error("ExpectedIfTargetToHaveALabel");
          }
          blocks.push({label, actions, flow: {type: CfgFlowType.If, trueTarget, falseTarget}});
          continue iterateLabels;
        }
        case ActionType.Jump: {
          const target: string | null | undefined = labels.get(parsedAction.endOffset + parsedAction.raw.offset);
          if (target === undefined) {
            throw new Error("ExpectedJumpTargetToHaveALabel");
          }
          blocks.push({label, actions, flow: {type: CfgFlowType.Simple, next: target}});
          continue iterateLabels;
        }
        case ActionType.Return: {
          blocks.push({label, actions, flow: {type: CfgFlowType.Return}});
          continue iterateLabels;
        }
        case ActionType.Throw: {
          blocks.push({label, actions, flow: {type: CfgFlowType.Throw}});
          continue iterateLabels;
        }
        case ActionType.Try: {
          const raw: Try = parsedAction.raw;

          const trySoftBlock: SoftBlock = (parsedAction as any).try;
          const catchSoftBlock: SoftBlock | undefined = (parsedAction as any).catch;
          const finallySoftBlock: SoftBlock | undefined = (parsedAction as any).finally;

          // Either `labels`, or `labels` with a jump to the start of the finally block.
          let tryCatchOuterLabels: Map<UintSize, CfgLabel | null> = labels;

          let finallyCfg: Cfg | undefined;
          if (finallySoftBlock !== undefined) {
            const finallyLabels: Map<UintSize, NullableCfgLabel> = resolveLabels(finallySoftBlock, labels);
            finallyCfg = buildCfg(parser, finallySoftBlock, finallyLabels, idp, labels.get(finallySoftBlock.end));
            tryCatchOuterLabels = new Map([...tryCatchOuterLabels]);
            tryCatchOuterLabels.set(finallySoftBlock.start, finallyLabels.get(finallySoftBlock.start)!);
          }

          const tryLabels: Map<UintSize, NullableCfgLabel> = resolveLabels(trySoftBlock, tryCatchOuterLabels);
          const tryCfg: Cfg = buildCfg(parser, trySoftBlock, tryLabels, idp, tryCatchOuterLabels.get(trySoftBlock.end));

          let catchBlock: CatchBlock | undefined;
          if (catchSoftBlock !== undefined) {
            const catchLabels: Map<UintSize, NullableCfgLabel> = resolveLabels(catchSoftBlock, tryCatchOuterLabels);
            const body: Cfg = buildCfg(
              parser,
              catchSoftBlock,
              catchLabels,
              idp,
              tryCatchOuterLabels.get(catchSoftBlock.end),
            );
            catchBlock = {target: raw.catch!.target, body};
          }
          blocks.push({
            label,
            actions,
            flow: {
              type: CfgFlowType.Try,
              try: tryCfg,
              catch: catchBlock,
              finally: finallyCfg,
            },
          });
          continue iterateLabels;
        }
        case ActionType.With: {
          const withSoft: SoftBlock = (parsedAction as any).with;
          // tslint:disable-next-line
          const withLabels: Map<UintSize, NullableCfgLabel> = resolveLabels(withSoft, labels);
          const withCfg: Cfg = buildCfg(parser, withSoft, withLabels, idp, labels.get(withSoft.end));
          blocks.push({label, actions, flow: {type: CfgFlowType.With, body: withCfg}});
          continue iterateLabels;
        }
        case ActionType.WaitForFrame: {
          const readyTarget: string | null | undefined = labels.get(parsedAction.endOffset);
          if (readyTarget === undefined) {
            throw new Error("ExpectedWaitForFrameIfLoadedToHaveALabel");
          }
          const loadingTarget: string | null | undefined = labels.get((parsedAction as any).notLoadedOffset);
          if (loadingTarget === undefined) {
            throw new Error("ExpectedWaitForFrameIfNotLoadedToHaveALabel");
          }
          const frame: UintSize = parsedAction.raw.frame;
          blocks.push({label, actions, flow: {type: CfgFlowType.WaitForFrame, frame, readyTarget, loadingTarget}});
          continue iterateLabels;
        }
        case ActionType.WaitForFrame2: {
          const readyTarget: string | null | undefined = labels.get(parsedAction.endOffset);
          if (readyTarget === undefined) {
            throw new Error("ExpectedWaitForFrame2IfLoadedToHaveALabel");
          }
          const loadingTarget: string | null | undefined = labels.get((parsedAction as any).notLoadedOffset);
          if (loadingTarget === undefined) {
            throw new Error("ExpectedWaitForFrame2IfNotLoadedToHaveALabel");
          }
          blocks.push({label, actions, flow: {type: CfgFlowType.WaitForFrame2, readyTarget, loadingTarget}});
          continue iterateLabels;
        }
        default:
          actions.push(parsedAction.raw);
          offset = parsedAction.endOffset;
          break;
      }
    } while (!labels.has(offset));
    const next: string | null | undefined = labels.get(offset);
    if (next === undefined) {
      throw new Error("MissingLabel");
    }
    blocks.push({label, actions, flow: {type: CfgFlowType.Simple, next}});
  }
  if (blocks.length === 0) {
    if (defaultNext === undefined) {
      throw new Error("AssertionError: Empty CFG without known `defaultNext`");
    }
    const label: NullableCfgLabel | undefined = labels.get(soft.start);
    if (label === null || label === undefined) {
      throw new Error("AssertionError: Expected empty block start label to have an id`");
    }
    const head: CfgBlock = {
      label,
      actions: [],
      flow: {
        type: CfgFlowType.Simple,
        next: defaultNext,
      },
    };
    return {blocks: [head]};
  } else {
    return {blocks};
  }
}
