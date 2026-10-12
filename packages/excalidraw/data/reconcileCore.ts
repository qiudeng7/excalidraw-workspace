// The editor and authoritative servers share these upstream reconciliation
// primitives. This entry has no DOM, React, geometry, or font dependencies.
import {
  orderByFractionalIndex,
  getInvalidIndicesGroups,
  generateIndices,
} from "../lib/element/src/fractionalIndexCore";

export { orderByFractionalIndex } from "../lib/element/src/fractionalIndexCore";

export interface VersionedElement {
  id: string;
  version: number;
  versionNonce: number;
  index?: string | null;
}

export interface EditingState {
  editingTextElement?: { id: string } | null;
  resizingElement?: { id: string } | null;
  newElement?: { id: string } | null;
}

export const shouldDiscardRemoteElement = (
  localAppState: EditingState,
  local: VersionedElement | undefined,
  remote: VersionedElement,
): boolean => {
  if (
    local &&
    // local element is being edited
    (local.id === localAppState.editingTextElement?.id ||
      local.id === localAppState.resizingElement?.id ||
      local.id === localAppState.newElement?.id ||
      // local element is newer
      local.version > remote.version ||
      // resolve conflicting edits deterministically by taking the one with
      // the lowest versionNonce
      (local.version === remote.version &&
        local.versionNonce <= remote.versionNonce))
  ) {
    return true;
  }

  return false;
};

export const reconcileElementVersions = <T extends VersionedElement>(
  localElements: readonly T[],
  remoteElements: readonly T[],
  localAppState: EditingState = {},
): T[] => {
  const localElementsMap = new Map(
    localElements.map((element) => [element.id, element]),
  );
  const reconciledElements: T[] = [];
  const added = new Set<string>();

  // process remote elements
  for (const remoteElement of remoteElements) {
    if (!added.has(remoteElement.id)) {
      const localElement = localElementsMap.get(remoteElement.id);
      const discardRemoteElement = shouldDiscardRemoteElement(
        localAppState,
        localElement,
        remoteElement,
      );

      if (localElement && discardRemoteElement) {
        reconciledElements.push(localElement);
        added.add(localElement.id);
      } else {
        reconciledElements.push(remoteElement);
        added.add(remoteElement.id);
      }
    }
  }

  // process remaining local elements
  for (const localElement of localElements) {
    if (!added.has(localElement.id)) {
      reconciledElements.push(localElement);
      added.add(localElement.id);
    }
  }

  const orderedElements = orderByFractionalIndex(reconciledElements);

  return orderedElements;
};

/** Compute the upstream index repairs without mutating scene objects. */
export function fractionalIndexUpdates<T extends VersionedElement>(
  elements: readonly T[],
) {
  return generateIndices(elements, getInvalidIndicesGroups(elements));
}
