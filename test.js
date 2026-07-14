const title = "2025 Panini Donruss WNBA - Net Marvels Sabrina Ionescu #7";
const specifics = {
  year: "2025",
  brand: "Panini",
  set: "Donruss WNBA",
  player: "Sabrina Ionescu",
  cardNumber: "7"
};

function hasWorldCupCountry(title) { return false; }
function inferWorldCupCountry(title) { return null; }
function extractBrandFromTitle(title) { return "Panini"; }

// Paste buildSeoTitle here
function buildSeoTitle(originalTitle, specifics) {
  const MAX_LENGTH = 80;

  // 1. Remove spammy fluff
  const FLUFF = /\b(WOW|L@@K|LOOK!*|AMAZING|GORGEOUS|BEAUTIFUL|MUST\s*SEE|FREE\s*SHIP(?:PING)?|FAST\s*SHIP(?:PING)?|HOT|FIRE|INVEST|GEM|MINT)\b/gi;
  let title = originalTitle.replace(FLUFF, '').replace(/\s{2,}/g, ' ').trim();

  // 2. Convert to Title Case to visually normalize EVERYTHING
  title = title.toLowerCase().split(/\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

  // 3. Standardize common trading-card abbreviations (Force Upper Case & Remove Parens)
  const abbrevMap = [
    [/\bpsa\b/gi, 'PSA'],
    [/\bbgs\b/gi, 'BGS'],
    [/\bsgc\b/gi, 'SGC'],
    [/\bcgc\b/gi, 'CGC'],
    [/\(?\brookie\s+card\b\)?/gi, 'RC'],
    [/\(?\b(?:rookie|rc)\b\)?/gi, 'RC'],
    [/\bauto(?:graph)?(?:ed)?\b/gi, 'Auto'],
    [/\brefractor\b/gi, 'Refractor'],
    [/\bholographic\b/gi, 'Holo'],
    [/\bprisms?\b/gi, 'Prizm'],
    [/\bparallel\b/gi, 'Parallel'],
    [/\bshort\s*print\b/gi, 'SP'],
    [/\bsuper\s*short\s*print\b/gi, 'SSP'],
    [/\bfifa\b/gi, 'FIFA'],
    [/\bmlb\b/gi, 'MLB'],
    [/\bnba\b/gi, 'NBA'],
    [/\bnfl\b/gi, 'NFL'],
    [/\bnhl\b/gi, 'NHL'],
    [/\bufc\b/gi, 'UFC'],
    [/\bwwe\b/gi, 'WWE'],
    [/\buefa\b/gi, 'UEFA'],
    [/\bwnba\b/gi, 'WNBA'],
    [/\bnwsl\b/gi, 'NWSL'],
    [/\busfl\b/gi, 'USFL'],
    [/\bxfl\b/gi, 'XFL'],
    [/\bmls\b/gi, 'MLS'],
  ];
  for (const [pattern, replacement] of abbrevMap) {
    title = title.replace(pattern, replacement);
  }

  title = title.replace(/\bRC(?:\s+RC)+\b/g, 'RC');
  title = title.replace(/\bWorld\s+Cup\b/gi, 'World Cup');

  if (/\bWorld\s+Cup\b/i.test(title) && !hasWorldCupCountry(title)) {
    const country = inferWorldCupCountry(title);
    if (country) {
      title = `${title} ${country}`;
    }
  }

  // 4. Force uppercase on any token that looks like a card number
  title = title.split(' ').map(word => word.startsWith('#') ? word.toUpperCase() : word).join(' ');

  // 5. Extract and Reorder components
  let playerStr = specifics?.player || '';
  if (playerStr) {
    playerStr = playerStr.toLowerCase().split(/\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }

  // Year
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

  // Clean up leftPart
  leftPart = leftPart.replace(/^[-–—,]\s*/, '').replace(/\s*[-–—,]$/, '').trim();
  // REMOVED SECOND TITLE CASING HERE

  if (leftPart) {
      const brand = specifics?.brand || extractBrandFromTitle(originalTitle);
      let set = specifics?.set || '';
      
      if (brand && set.toLowerCase().includes(brand.toLowerCase())) {
          set = set.replace(new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '').trim();
      }
      
      let matchedBrandSet = '';
      let remainingLeft = leftPart;
      
      if (brand) {
        const safeBrand = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const brandRegex = new RegExp(`\\b${safeBrand}\\b`, 'gi');
        const match = remainingLeft.match(brandRegex);
        if (match) {
           matchedBrandSet += match[0] + ' ';
           remainingLeft = remainingLeft.replace(brandRegex, ' ').trim();
        }
      }
      if (set) {
        const safeSet = set.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const setRegex = new RegExp(`\\b${safeSet}\\b`, 'gi');
        const match = remainingLeft.match(setRegex);
        if (match) {
           matchedBrandSet += match[0] + ' ';
           remainingLeft = remainingLeft.replace(setRegex, ' ').trim();
        }
      }
      
      if (matchedBrandSet) {
          leftPart = matchedBrandSet.trim();
          if (remainingLeft) {
              rightPart = remainingLeft + ' ' + rightPart;
          }
      }
  }

  // Card Number
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

  // Attributes
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

  // Grade
  const grades = [];
  const gradeRegex = /\b(PSA|BGS|SGC|CGC)\s*(10|9\.5|9|8\.5|8|7|6|5|4|3|2|1\.5|1)\b/gi;
  let gradeMatch;
  while ((gradeMatch = gradeRegex.exec(rightPart)) !== null) {
    grades.push(`${gradeMatch[1].toUpperCase()} ${gradeMatch[2]}`);
  }
  rightPart = rightPart.replace(gradeRegex, ' ').replace(/\s{2,}/g, ' ').trim();

  // Clean up title (which is now strictly Insert/Parallel/Color + Team info)
  rightPart = rightPart.replace(/\s{2,}/g, ' ').replace(/^[-–—,]\s*/, '').replace(/\s*[-–—,]$/, '').replace(/\s*,\s*/g, ' ').trim();

  // Reconstruct: [Year] [Brand & Set] - [Player Name] [Card #] - [Insert/Parallel/Color] [Attributes] [Grade]
  let finalParts = [];
  if (yearStr) finalParts.push(yearStr);
  if (leftPart) finalParts.push(leftPart); // Brand & Set
  
  if (playerStr) {
      if (leftPart) finalParts.push('-');
      finalParts.push(playerStr);
  }
  if (extractedCardNum) finalParts.push(extractedCardNum);
  
  if (rightPart) {
      if (leftPart || playerStr) finalParts.push('-');
      finalParts.push(rightPart); // Insert/Parallel/Color
  }
  if (attributes.length > 0) finalParts.push(attributes.join(' '));
  if (grades.length > 0) finalParts.push(grades.join(' '));

  title = finalParts.join(' ').replace(/\s{2,}/g, ' ').trim();

  // 7. Truncate to eBay's 80-character hard limit without splitting words
  if (title.length > MAX_LENGTH) {
    const cut = title.lastIndexOf(' ', MAX_LENGTH);
    title = title.substring(0, cut > MAX_LENGTH - 15 ? cut : MAX_LENGTH).trim();
  }

  return title;
}

console.log("With full specifics:", buildSeoTitle(title, specifics));
