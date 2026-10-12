import { arrayToMap } from "@excalidraw/common";

import {
  getInvalidIndicesGroups,
  generateIndices,
  isValidFractionalIndex,
} from "./fractionalIndexCore";

import { mutateElement, newElementWith } from "./mutateElement";
import { getBoundTextElementId } from "./textElement";
import { hasBoundTextElement } from "./typeChecks";

import { isNonDeletedElement } from ".";

import type {
  ElementsMap,
  ExcalidrawElement,
  Ordered,
  OrderedExcalidrawElement,
  SceneElementsMap,
} from "./types";

export { orderByFractionalIndex } from "./fractionalIndexCore";

export class InvalidFractionalIndexError extends Error {
  public code = "ELEMENT_HAS_INVALID_INDEX" as const;
}

/**
 * Envisioned relation between array order and fractional indices:
 *
 * 1) Array (or array-like ordered data structure) should be used as a cache of elements order, hiding the internal fractional indices implementation.
 * - it's undesirable to perform reorder for each related operation, therefore it's necessary to cache the order defined by fractional indices into an ordered data structure
 * - it's easy enough to define the order of the elements from the outside (boundaries), without worrying about the underlying structure of fractional indices (especially for the host apps)
 * - it's necessary to always keep the array support for backwards compatibility (restore) - old scenes, old libraries, supporting multiple excalidraw versions etc.
 * - it's necessary to always keep the fractional indices in sync with the array order
 * - elements with invalid indices should be detected and synced, without altering the already valid indices
 *
 * 2) Fractional indices should be used to reorder the elements, whenever the cached order is expected to be invalidated.
 * - as the fractional indices are encoded as part of the elements, it opens up possibilities for incremental-like APIs
 * - re-order based on fractional indices should be part of (multiplayer) operations such as reconciliation & undo/redo
 * - technically all the z-index actions could perform also re-order based on fractional indices,but in current state it would not bring much benefits,
 *   as it's faster & more efficient to perform re-order based on array manipulation and later synchronisation of moved indices with the array order
 */

/**
 * Ensure that all elements have valid fractional indices.
 *
 * @throws `InvalidFractionalIndexError` if invalid index is detected.
 */
export const validateFractionalIndices = (
  elements: readonly ExcalidrawElement[],
  {
    shouldThrow = false,
    includeBoundTextValidation = false,
    ignoreLogs,
    reconciliationContext,
  }: {
    shouldThrow: boolean;
    includeBoundTextValidation: boolean;
    ignoreLogs?: true;
    reconciliationContext?: {
      localElements: ReadonlyArray<ExcalidrawElement>;
      remoteElements: ReadonlyArray<ExcalidrawElement>;
    };
  },
) => {
  const errorMessages = [];
  const stringifyElement = (element: ExcalidrawElement | void) =>
    `${element?.index}:${element?.id}:${element?.type}:${element?.isDeleted}:${element?.version}:${element?.versionNonce}`;

  const elementsMap = includeBoundTextValidation ? arrayToMap(elements) : null;

  const indices = elements.map((x) => x.index);

  for (const [i, index] of indices.entries()) {
    const predecessorIndex = indices[i - 1];
    const successorIndex = indices[i + 1];

    if (!isValidFractionalIndex(index, predecessorIndex, successorIndex)) {
      errorMessages.push(
        `Fractional indices invariant has been compromised: "${stringifyElement(
          elements[i - 1],
        )}", "${stringifyElement(elements[i])}", "${stringifyElement(
          elements[i + 1],
        )}"`,
      );
    }

    // disabled by default, as we don't fix it
    if (
      includeBoundTextValidation &&
      elementsMap &&
      hasBoundTextElement(elements[i]) &&
      isNonDeletedElement(elements[i])
    ) {
      const container = elements[i];
      const boundTextElementId = getBoundTextElementId(container);
      const text = boundTextElementId
        ? elementsMap.get(boundTextElementId)
        : null;

      if (
        text &&
        isNonDeletedElement(text) &&
        text.index! <= container.index!
      ) {
        errorMessages.push(
          `Fractional indices invariant for bound elements has been compromised: "${stringifyElement(
            text,
          )}", "${stringifyElement(container)}"`,
        );
      }
    }
  }

  if (errorMessages.length) {
    const error = new InvalidFractionalIndexError();
    const additionalContext = [];

    if (reconciliationContext) {
      additionalContext.push("Additional reconciliation context:");
      additionalContext.push(
        reconciliationContext.localElements.map((x) => stringifyElement(x)),
      );
      additionalContext.push(
        reconciliationContext.remoteElements.map((x) => stringifyElement(x)),
      );
    }

    if (!ignoreLogs) {
      // report just once and with the stacktrace
      console.error(
        errorMessages.join("\n\n"),
        error.stack,
        elements.map((x) => stringifyElement(x)),
        ...additionalContext,
      );
    }

    if (shouldThrow) {
      // if enabled, gather all the errors first, throw once
      throw error;
    }
  }
};

/**
 * Synchronizes invalid fractional indices of moved elements with the array order by mutating passed elements.
 * If the synchronization fails or the result is invalid, it fallbacks to `syncInvalidIndices`.
 */
export const syncMovedIndices = (
  elements: readonly ExcalidrawElement[],
  movedElements: ElementsMap,
): OrderedExcalidrawElement[] => {
  try {
    const elementsMap = arrayToMap(elements);
    const indicesGroups = getMovedIndicesGroups(elements, movedElements);

    // try generatating indices, throws on invalid movedElements
    const elementsUpdates = generateIndices(elements, indicesGroups);
    const elementsCandidates = elements.map((x) => {
      const elementUpdates = elementsUpdates.get(x);

      if (elementUpdates) {
        return { ...x, index: elementUpdates.index };
      }

      return x;
    });

    // ensure next indices are valid before mutation, throws on invalid ones
    validateFractionalIndices(
      elementsCandidates,
      // we don't autofix invalid bound text indices, hence don't include it in the validation
      {
        includeBoundTextValidation: false,
        shouldThrow: true,
        ignoreLogs: true,
      },
    );

    // split mutation so we don't end up in an incosistent state
    for (const [element, { index }] of elementsUpdates) {
      mutateElement(element, elementsMap, { index });
    }
  } catch (error) {
    console.warn(
      "Fractional index update failed; repairing element ordering",
      error,
    );
    // fallback to default sync
    syncInvalidIndices(elements);
  }

  return elements as OrderedExcalidrawElement[];
};

/**
 * Synchronizes all invalid fractional indices within the array order by mutating elements in the passed array.
 *
 * WARN: in edge cases it could modify the elements which were not moved, as it's impossible to guess the actually moved elements from the elements array itself.
 */
export const syncInvalidIndices = <T extends ExcalidrawElement>(
  elements: readonly T[],
): Ordered<T>[] => {
  const elementsMap = arrayToMap(elements);
  const indicesGroups = getInvalidIndicesGroups(elements);
  const elementsUpdates = generateIndices<ExcalidrawElement>(
    elements,
    indicesGroups,
  );

  for (const [element, { index }] of elementsUpdates) {
    mutateElement(element, elementsMap, { index });
  }

  return elements as Ordered<T>[];
};

/**
 * Synchronizes all invalid fractional indices within the array order by creating new instances of elements with corrected indices.
 *
 * WARN: in edge cases it could modify the elements which were not moved, as it's impossible to guess the actually moved elements from the elements array itself.
 */
export const syncInvalidIndicesImmutable = (
  elements: readonly ExcalidrawElement[],
): SceneElementsMap | undefined => {
  const syncedElements = arrayToMap(elements);
  const indicesGroups = getInvalidIndicesGroups(elements);
  const elementsUpdates = generateIndices(elements, indicesGroups);

  for (const [element, { index }] of elementsUpdates) {
    syncedElements.set(element.id, newElementWith(element, { index }));
  }

  return syncedElements as SceneElementsMap;
};

/**
 * Get contiguous groups of indices of passed moved elements.
 *
 * NOTE: First and last elements within the groups are indices of lower and upper bounds.
 */
const getMovedIndicesGroups = (
  elements: readonly ExcalidrawElement[],
  movedElements: ElementsMap,
) => {
  const indicesGroups: number[][] = [];

  let i = 0;

  while (i < elements.length) {
    if (movedElements.has(elements[i].id)) {
      const indicesGroup = [i - 1, i]; // push the lower bound index as the first item

      while (++i < elements.length) {
        if (!movedElements.has(elements[i].id)) {
          break;
        }

        indicesGroup.push(i);
      }

      indicesGroup.push(i); // push the upper bound index as the last item
      indicesGroups.push(indicesGroup);
    } else {
      i++;
    }
  }

  return indicesGroups;
};
