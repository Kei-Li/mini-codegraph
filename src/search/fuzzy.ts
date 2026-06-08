const MAX_EDIT_DISTANCE = 3

export function damerauLevenshtein(a: string, b: string): number {
  const an = a.length
  const bn = b.length
  if (an === 0) return bn
  if (bn === 0) return an

  const matrix: number[][] = []
  for (let i = 0; i <= an; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= bn; j++) {
    matrix[0][j] = j
  }

  for (let i = 1; i <= an; i++) {
    for (let j = 1; j <= bn; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + cost)
      }
    }
  }

  return matrix[an][bn]
}

export function findFuzzyMatches(
  query: string,
  candidates: { id: string; name: string; qualifiedName: string }[],
  maxResults = 10
): { id: string; name: string; distance: number }[] {
  const queryLower = query.toLowerCase()
  const results: { id: string; name: string; distance: number }[] = []

  for (const c of candidates) {
    const nameLower = c.name.toLowerCase()
    const qnLower = c.qualifiedName.toLowerCase()

    const nameDist = damerauLevenshtein(queryLower, nameLower)
    const qnDist = damerauLevenshtein(queryLower, qnLower)
    const minDist = Math.min(nameDist, qnDist)

    if (minDist <= MAX_EDIT_DISTANCE) {
      results.push({ id: c.id, name: c.name, distance: minDist })
    }
  }

  return results
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxResults)
}

export function extractSearchTerms(text: string): string[] {
  return text
    .split(/\s+/)
    .map(t => t.replace(/[^a-zA-Z0-9_]/g, ''))
    .filter(t => t.length > 1)
}

export function matchCamelCase(text: string): string[] {
  return text.match(/[A-Z][a-z]+(?:[A-Z][a-z]+)*/g) ?? []
}

export function splitCamelCase(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}
