const BASE = 'https://api.dictionaryapi.dev/api/v2/entries/en';

// Returns { word, partOfSpeech, definition, example? } or null if not found.
export async function fetchDefinition(word) {
  let res;
  try {
    res = await fetch(`${BASE}/${encodeURIComponent(word)}`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(data) || !data[0]) return null;

  const entry = data[0];
  const meanings = entry.meanings ?? [];
  for (const meaning of meanings) {
    const def = meaning.definitions?.find((d) => d?.definition);
    if (def) {
      return {
        word: entry.word ?? word,
        partOfSpeech: meaning.partOfSpeech ?? '',
        definition: def.definition,
        example: def.example,
      };
    }
  }
  return null;
}
