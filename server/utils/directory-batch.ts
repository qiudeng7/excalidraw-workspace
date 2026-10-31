import type {
  BatchDirectoryRequest,
  BatchMoveDirectoryRequest,
  BatchUndoDirectoryRequest,
  NodeRef,
} from "#shared/directory-contracts";
import { ApiError, isObject } from "#server/utils/http";

const invalid = (): never => {
  throw new ApiError(400, "INVALID_DIRECTORY_BATCH", "批量目录参数无效");
};

const parseRef = (value: unknown): NodeRef | null => {
  if (!isObject(value)) return null;
  if (
    (value.kind !== "folder" && value.kind !== "canvas") ||
    typeof value.id !== "string" ||
    !value.id
  )
    return null;

  return { kind: value.kind, id: value.id };
};

const parseBase = (data: Record<string, unknown>): BatchDirectoryRequest => {
  const rawSources = data.sources;
  const catalogRevision = data.catalogRevision;

  if (
    !Array.isArray(rawSources) ||
    !rawSources.length ||
    rawSources.length > 100 ||
    typeof catalogRevision !== "number" ||
    !Number.isSafeInteger(catalogRevision) ||
    catalogRevision < 0
  )
    return invalid();
  const sources = rawSources.map(parseRef);

  if (sources.some((source) => !source)) return invalid();
  const refs = sources as NodeRef[];

  if (new Set(refs.map((ref) => `${ref.kind}:${ref.id}`)).size !== refs.length)
    return invalid();

  return { sources: refs, catalogRevision };
};

export const batchDirectoryRequest = parseBase;

export const batchMoveDirectoryRequest = (
  data: Record<string, unknown>,
): BatchMoveDirectoryRequest => {
  const base = parseBase(data);
  const parentId = data.parentId;
  const placement = data.placement;
  const target = data.target === undefined ? undefined : parseRef(data.target);

  if (
    (parentId !== null && typeof parentId !== "string") ||
    (placement !== "before" && placement !== "after" && placement !== "end") ||
    (placement === "end" ? target !== undefined : target === undefined)
  )
    return invalid();
  if (data.target !== undefined && !target) return invalid();

  return {
    ...base,
    parentId: parentId as string | null,
    target: target ?? undefined,
    placement: placement as BatchMoveDirectoryRequest["placement"],
  };
};

export const batchUndoDirectoryRequest = (
  data: Record<string, unknown>,
): BatchUndoDirectoryRequest => {
  if (!isObject(data.receipt)) invalid();

  return { receipt: data.receipt as BatchUndoDirectoryRequest["receipt"] };
};
