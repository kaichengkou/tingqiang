export function lyricCues(lines, duration, offset = 0) {
  const timed = lines.map((line, index) => ({...line, lineIndex: index})).filter(line => line.t !== null && line.text).sort((a, b) => a.t - b.t);
  const cues = [];
  for (let i = 0; i < timed.length; i++) {
    const line = timed[i];
    const lineEnd = Math.min(line.end ?? Infinity, timed[i + 1]?.t ?? duration, duration);
    const words = line.words?.length ? line.words : [{t: line.t, text: line.text}];
    let charOffset = 0;
    for (let w = 0; w < words.length; w++) {
      const word = words[w], end = Math.min(words[w + 1]?.t ?? lineEnd, lineEnd);
      if (word.text && end > word.t && end + offset > 0) cues.push({t: Math.max(0, word.t + offset), end: Math.min(duration, end + offset), text: word.text, lineIndex: line.lineIndex, wordIndex: line.words?.length ? w : -1, charOffset, wordTimed: !!line.words?.length});
      charOffset += [...word.text].length;
    }
  }
  return cues;
}

export function firstLyricTime(lines, duration, offset = 0) {
  const times = lines.filter(line => line.text && line.t !== null && line.t + offset >= 0 && line.t + offset < duration).map(line => line.t + offset);
  return times.length ? Math.min(...times) : null;
}
