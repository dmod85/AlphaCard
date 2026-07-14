const title = "2025 Panini Hailey Van Lith #24 Donruss WNBA Net Marvels RC";
const specifics = {
  year: "2025",
  brand: "Panini",
  set: "Donruss WNBA",
  player: "Hailey Van Lith",
  cardNumber: "24"
};

function hasWorldCupCountry(title) { return false; }
function inferWorldCupCountry(title) { return null; }
function extractBrandFromTitle(title) { return "Panini"; }

// Paste buildSeoTitle here
function buildSeoTitle(originalTitle, specifics) {
  const MAX_LENGTH = 80;

  const FLUFF = /\b(WOW|L@@K|LOOK!*|AMAZING|GORGEOUS|BEAUTIFUL|MUST\s*SEE|FREE\s*SHIP(?:PING)?|FAST\s*SHIP(?:PING)?|HOT|FIRE|INVEST|GEM|MINT)\b/gi;
  let title = originalTitle.replace(FLUFF, '').replace(/\s{2,}/g, ' ').trim();

  title = title.toLowerCase().split(/\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

  const abbrevMap = [
    [/\bpsa\b/gi, 'PSA'], [/\bbgs\b/gi, 'BGS'], [/\bsgc\b/gi, 'SGC'], [/\bcgc\b/gi, 'CGC'],
    [/\(?\brookie\s+card\b\)?/gi, 'RC'], [/\(?\b(?:rookie|rc)\b\)?/gi, 'RC'],
    [/\bauto(?:graph)?(?:ed)?\b/gi, 'Auto'], [/\brefractor\b/gi, 'Refractor'],
    [/\bholographic\b/gi, 'Holo'], [/\bprisms?\b/gi, 'Prizm'],
    [/\bparallel\b/gi, 'Parallel'], [/\bshort\s*print\b/gi, 'SP'],
    [/\bsuper\s*short\s*print\b/gi, 'SSP'], [/\bfifa\b/gi, 'FIFA'],
    [/\bmlb\b/gi, 'MLB'], [/\bnba\b/gi, 'NBA'], [/\bnfl\b/gi, 'NFL'],
    [/\bnhl\b/gi, 'NHL'], [/\bufc\b/gi, 'UFC'], [/\bwwe\b/gi, 'WWE'],
    [/\buefa\b/gi, 'UEFA'], [/\bwnba\b/gi, 'WNBA'], [/\bnwsl\b/gi, 'NWSL'],
    [/\busfl\b/gi, 'USFL'], [/\bxfl\b/gi, 'XFL'], [/\bmls\b/gi, 'MLS'],
  ];
  for (const [pattern, replacement] of abbrevMap) {
    title = title.replace(pattern, replacement);
  }

  title = title.replace(/\bRC(?:\s+RC)+\b/g, 'RC');
  title = title.replace(/\bWorld\s+Cup\b/gi, 'World Cup');

  if (/\bWorld\s+Cup\b/i.test(title) && !hasWorldCupCountry(title)) {
    const country = inferWorldCupCountry(title);
    if (country) { title = `${title} ${country}`; }
  }
  title = title.split(' ').map(word => word.startsWith('#') ? word.toUpperCase() : word).join(' ');

  let playerStr = specifics?.player || '';
  if (playerStr) {
    playerStr = playerStr.toLowerCase().split(/\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }

  const yearStr = specifics?.year?.match(/\b(19|20)\d{2}\b/)?.[0] || title.match(/\b(19|20)\d{2}\b/)?.[0] || '';
  if (yearStr) {
    title = title.replace(new RegExp(`\\b${yearStr}\\b`, 'g'), '').replace(/\s{2,}/g, ' ').trim();
  }

  let leftPart = '';
  let rightPart = title;

  if (playerStr) {
    const safePlayer = playerStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const playerRegex = new RegExp(`\\b${safePlayer}\\b`, 'i');
    const match = playerRegex.exec(rightPart);
    if (match) {
      leftPart = rightPart.substring(0, match.index).trim();
      rightPart = rightPart.substring(match.index + match[0].length).trim();
    }
  }

  leftPart = leftPart.replace(/^[-–—,]\s*/, '').replace(/\s*[-–—,]$/, '').trim();

  // ----- NEW LOGIC -----
  const brand = specifics?.brand || extractBrandFromTitle(originalTitle);
  let set = specifics?.set || '';
  
  if (brand && set.toLowerCase().includes(brand.toLowerCase())) {
      set = set.replace(new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '').trim();
  }
  
  let finalBrandSet = '';
  
  if (brand) {
      const safeBrand = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const brandRegex = new RegExp(`\\b${safeBrand}\\b`, 'gi');
      
      let match = leftPart.match(brandRegex) || rightPart.match(brandRegex);
      if (match) {
          // Keep the capitalization from the title match if it exists
          finalBrandSet += match[0] + ' ';
      } else {
          // Capitalize brand properly if forcing
          const forcedBrand = brand.toLowerCase().split(/\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
          finalBrandSet += forcedBrand + ' '; 
      }
      leftPart = leftPart.replace(brandRegex, ' ').trim();
      rightPart = rightPart.replace(brandRegex, ' ').trim();
  }
  
  if (set) {
      const safeSet = set.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const setRegex = new RegExp(`\\b${safeSet}\\b`, 'gi');
      
      let match = leftPart.match(setRegex) || rightPart.match(setRegex);
      if (match) {
          finalBrandSet += match[0] + ' ';
      } else {
          // Capitalize set properly if forcing
          // Wait, abbreviations won't be applied to forced set! We should run abbrevMap on it if we force it.
          let forcedSet = set.toLowerCase().split(/\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
          for (const [pattern, replacement] of abbrevMap) {
              forcedSet = forcedSet.replace(pattern, replacement);
          }
          finalBrandSet += forcedSet + ' ';
      }
      leftPart = leftPart.replace(setRegex, ' ').trim();
      rightPart = rightPart.replace(setRegex, ' ').trim();
  }
  
  if (leftPart) {
      rightPart = leftPart + ' ' + rightPart;
  }
  
  leftPart = finalBrandSet.trim();
  // ---------------------

  let cardNumStr = specifics?.cardNumber ? specifics.cardNumber.trim().toUpperCase() : '';
  let extractedCardNum = '';
  if (cardNumStr) {
    const safeNum = cardNumStr.replace(/[^A-Z0-9]/g, '');
    const numPattern = new RegExp(`(?:^|\\s)#?\\s*${safeNum}\\b`, 'i');
    if (numPattern.test(rightPart)) {
      rightPart = rightPart.replace(numPattern, ' ').trim();
    }
    extractedCardNum = cardNumStr.startsWith('#') ? cardNumStr : `#${cardNumStr}`;
  } else {
    const hashMatch = rightPart.match(/(?:^|\s)#[A-Z0-9-]+\b/i);
    if (hashMatch) {
      extractedCardNum = hashMatch[0].trim().toUpperCase();
      rightPart = rightPart.replace(hashMatch[0], ' ').trim();
    }
  }

  const attributes = [];
  const attrRegex = /\b(RC|AUTO|RPA|SP|SSP)\b/gi;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(rightPart)) !== null) {
    attributes.push(attrMatch[1].toUpperCase());
  }
  rightPart = rightPart.replace(attrRegex, ' ').replace(/\s{2,}/g, ' ').trim();

  const serialRegex = /(?:^|\s)(\d{1,5}\/\d{1,5}|\/\d{1,5})\b/g;
  let serialMatch;
  while ((serialMatch = serialRegex.exec(rightPart)) !== null) {
    attributes.push(serialMatch[1]);
  }
  rightPart = rightPart.replace(serialRegex, ' ').replace(/\s{2,}/g, ' ').trim();

  const grades = [];
  const gradeRegex = /\b(PSA|BGS|SGC|CGC)\s*(10|9\.5|9|8\.5|8|7|6|5|4|3|2|1\.5|1)\b/gi;
  let gradeMatch;
  while ((gradeMatch = gradeRegex.exec(rightPart)) !== null) {
    grades.push(`${gradeMatch[1].toUpperCase()} ${gradeMatch[2]}`);
  }
  rightPart = rightPart.replace(gradeRegex, ' ').replace(/\s{2,}/g, ' ').trim();

  rightPart = rightPart.replace(/\s{2,}/g, ' ').replace(/^[-–—,]\s*/, '').replace(/\s*[-–—,]$/, '').replace(/\s*,\s*/g, ' ').trim();

  let finalParts = [];
  if (yearStr) finalParts.push(yearStr);
  if (leftPart) finalParts.push(leftPart);
  
  if (playerStr) {
      if (leftPart) finalParts.push('-');
      finalParts.push(playerStr);
  }
  
  if (extractedCardNum) finalParts.push(extractedCardNum);
  
  if (rightPart) {
      if (leftPart || playerStr) finalParts.push('-');
      finalParts.push(rightPart);
  }
  
  if (attributes.length > 0) finalParts.push(attributes.join(' '));
  if (grades.length > 0) finalParts.push(grades.join(' '));

  title = finalParts.join(' ').replace(/\s{2,}/g, ' ').trim();
  
  if (title.length > MAX_LENGTH) {
    const cut = title.lastIndexOf(' ', MAX_LENGTH);
    title = title.substring(0, cut > MAX_LENGTH - 15 ? cut : MAX_LENGTH).trim();
  }

  return title;
}

console.log("Output:", buildSeoTitle(title, specifics));
