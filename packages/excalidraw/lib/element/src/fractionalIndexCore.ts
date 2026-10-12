import {
  validateOrderKey,
  generateNKeysBetween,
} from "@excalidraw/fractional-indexing";

export interface IndexedElement {
  id: string;
  index?: string | null;
}

/**
 * Order the elements based on the fractional indices.
 * - when fractional indices are identical, break the tie based on the element id
 * - when there is no fractional index in one of the elements, respect the order of the array
 */
export const orderByFractionalIndex = <T extends IndexedElement>(
  elements: T[],
) => {
  return elements.sort((a, b) => {
    // in case the indices are not the defined at runtime
    if (a.index && b.index) {
      if (a.index < b.index) {
        return -1;
      } else if (a.index > b.index) {
        return 1;
      }

      // break ties based on the element id
      return a.id < b.id ? -1 : 1;
    }

    // defensively keep the array order
    return 1;
  });
};

/**
 * Gets contiguous groups of all invalid indices automatically detected inside the elements array.
 *
 * WARN: First and last items within the groups do NOT have to be contiguous, those are the found lower and upper bounds!
 */
export const getInvalidIndicesGroups = (
  elements: readonly IndexedElement[],
) => {
  const indicesGroups: number[][] = [];

  // once we find lowerBound / upperBound, it cannot be lower than that, so we cache it for better perf.
  let lowerBound: IndexedElement["index"] | undefined = undefined;
  let upperBound: IndexedElement["index"] | undefined = undefined;
  let lowerBoundIndex: number = -1;
  let upperBoundIndex: number = 0;

  /** @returns maybe valid lowerBound */
  const getLowerBound = (
    index: number,
  ): [IndexedElement["index"] | undefined, number] => {
    const lowerBound = elements[lowerBoundIndex]
      ? elements[lowerBoundIndex].index
      : undefined;

    // we are already iterating left to right, therefore there is no need for additional looping
    const candidate = elements[index - 1]?.index;

    if (
      (!lowerBound && candidate) || // first lowerBound
      (lowerBound && candidate && candidate > lowerBound) // next lowerBound
    ) {
      // WARN: candidate's index could be higher or same as the current element's index
      return [candidate, index - 1];
    }

    // cache hit! take the last lower bound
    return [lowerBound, lowerBoundIndex];
  };

  /** @returns always valid upperBound */
  const getUpperBound = (
    index: number,
  ): [IndexedElement["index"] | undefined, number] => {
    const upperBound = elements[upperBoundIndex]
      ? elements[upperBoundIndex].index
      : undefined;

    // cache hit! don't let it find the upper bound again
    if (upperBound && index < upperBoundIndex) {
      return [upperBound, upperBoundIndex];
    }

    // set the current upperBoundIndex as the starting point
    let i = upperBoundIndex;

    while (++i < elements.length) {
      const candidate = elements[i]?.index;

      if (
        (!upperBound && candidate) || // first upperBound
        (upperBound && candidate && candidate > upperBound) // next upperBound
      ) {
        return [candidate, i];
      }
    }

    // we reached the end, sky is the limit
    return [undefined, i];
  };

  let i = 0;

  while (i < elements.length) {
    const current = elements[i].index;

    [lowerBound, lowerBoundIndex] = getLowerBound(i);
    [upperBound, upperBoundIndex] = getUpperBound(i);

    if (!isValidFractionalIndex(current, lowerBound, upperBound)) {
      // push the lower bound index as the first item
      const indicesGroup = [lowerBoundIndex, i];

      while (++i < elements.length) {
        const current = elements[i].index;
        const [nextLowerBound, nextLowerBoundIndex] = getLowerBound(i);
        const [nextUpperBound, nextUpperBoundIndex] = getUpperBound(i);

        if (isValidFractionalIndex(current, nextLowerBound, nextUpperBound)) {
          break;
        }

        // assign bounds only for the moved elements
        [lowerBound, lowerBoundIndex] = [nextLowerBound, nextLowerBoundIndex];
        [upperBound, upperBoundIndex] = [nextUpperBound, nextUpperBoundIndex];

        indicesGroup.push(i);
      }

      // push the upper bound index as the last item
      indicesGroup.push(upperBoundIndex);
      indicesGroups.push(indicesGroup);
    } else {
      i++;
    }
  }

  return indicesGroups;
};

export const isValidFractionalIndex = (
  index: IndexedElement["index"] | undefined,
  predecessor: IndexedElement["index"] | undefined,
  successor: IndexedElement["index"] | undefined,
) => {
  if (!index) {
    return false;
  }

  try {
    // Format validation
    validateOrderKey(index);
  } catch (error) {
    console.debug("Invalid fractional order key", error);

    return false;
  }

  if (predecessor && successor) {
    return predecessor < index && index < successor;
  }

  if (!predecessor && successor) {
    // first element
    return index < successor;
  }

  if (predecessor && !successor) {
    // last element
    return predecessor < index;
  }

  // only element in the array
  return !!index;
};

export const generateIndices = <T extends IndexedElement>(
  elements: readonly T[],
  indicesGroups: number[][],
) => {
  const elementsUpdates = new Map<T, { index: NonNullable<T["index"]> }>();

  for (const indices of indicesGroups) {
    const lowerBoundIndex = indices.shift()!;
    const upperBoundIndex = indices.pop()!;

    const fractionalIndices = generateNKeysBetween(
      elements[lowerBoundIndex]?.index,
      elements[upperBoundIndex]?.index,
      indices.length,
    ) as NonNullable<T["index"]>[];

    for (let i = 0; i < indices.length; i++) {
      const element = elements[indices[i]];

      elementsUpdates.set(element, {
        index: fractionalIndices[i],
      });
    }
  }

  return elementsUpdates;
};
