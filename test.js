const title = "2026 Topps Series 1 Freddie Freeman #GH-7 2025 Greatest Hits #GH-7 #GH-7";
const specifics = {
  year: "2026",
  brand: "Topps",
  set: "Series 1",
  player: "Freddie Freeman",
  cardNumber: "GH-7"
};

function hasWorldCupCountry(title) { return false; }
function inferWorldCupCountry(title) { return null; }
function extractBrandFromTitle(title) { return "Topps"; }

function buildSeoTitle(originalTitle, specifics) {
  const MAX_LENGTH = 80;

  const FLUFF = /\b(WOW|L@@K|LOOK!*|AMAZING|GORGEOUS|BEAUTIFUL|MUST\s*SEE|FREE\s*SHIP(?:PING)?|FAST\s*SHIP(?:PING)?|HOT|FIRE|INVEST|GEM|MINT)\b/gi;
  let title = originalTitle.replace(FLUFF, '').replace(/\s{2,}/g, ' ').trim();

  title = title.toLowerCase().split(/\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

  const abbrevMap = [
    [/\bpsa\b/gi, 'PSA'], [/\bbgs\b/gi, 'BGS'], [/\bsgc\b/gi, 'SGC'], [/\bcgc\b/gi, 'CGC'],
    [/\(?\brookie\s+card\b\)?/gi, 'RC'], [/\(?\b(?:rookie|rc)\b\)?/gi, 'RC'],
  ];
  for (const [pattern, replacement] of abbrevMap) {
    title = title.replace(pattern, replacement);
  }

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

  const brand = specifics?.brand || extractBrandFromTitle(originalTitle);
  let set = specifics?.set || '';
  
  if (yearStr && set.includes(yearStr)) {
      set = set.replace(new RegExp(`\\b${yearStr}\\b`, 'gi'), '').trim();
  }

  if (brand && set.toLowerCase().includes(brand.toLowerCase())) {
      set = set.replace(new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '').trim();
  }
  
  let finalBrandSet = '';
  
  if (brand) {
      const safeBrand = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const brandRegex = new RegExp(`\\b${safeBrand}\\b`, 'gi');
      
      let match = leftPart.match(brandRegex) || rightPart.match(brandRegex);
      if (match) {
          finalBrandSet += match[0] + ' ';
      } else {
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
          let forcedSet = set.toLowerCase().split(/\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
          finalBrandSet += forcedSet + ' ';
      }
      leftPart = leftPart.replace(setRegex, ' ').trim();
      rightPart = rightPart.replace(setRegex, ' ').trim();
  }
  
  if (leftPart) {
      rightPart = leftPart + ' ' + rightPart;
  }
  
  leftPart = finalBrandSet.trim();

  let cardNumStr = specifics?.cardNumber ? specifics.cardNumber.trim().toUpperCase() : '';
  let extractedCardNum = '';
  
  // ----- FIX: Better Card Number Extraction -----
  if (cardNumStr) {
    const safeNumExact = cardNumStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const numPatternExact = new RegExp(`(?:^|\\s)#?\\s*${safeNumExact}\\b`, 'gi');
    rightPart = rightPart.replace(numPatternExact, ' ').trim();

    const safeNumAlpha = cardNumStr.replace(/[^A-Z0-9]/ig, '');
    if (safeNumAlpha && safeNumAlpha !== cardNumStr) {
        const numPatternAlpha = new RegExp(`(?:^|\\s)#?\\s*${safeNumAlpha}\\b`, 'gi');
        rightPart = rightPart.replace(numPatternAlpha, ' ').trim();
    }

    extractedCardNum = cardNumStr.startsWith('#') ? cardNumStr : `#${cardNumStr}`;
  } else {
    const hashMatch = rightPart.match(/(?:^|\s)#[A-Z0-9-]+\b/i);
    if (hashMatch) {
      extractedCardNum = hashMatch[0].trim().toUpperCase();
      rightPart = rightPart.replace(new RegExp(hashMatch[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), ' ').trim();
    }
  }
  // ----------------------------------------------

  rightPart = rightPart.replace(/\s{2,}/g, ' ').replace(/^[-–—,\s]+/, '').replace(/[-–—,\s]+$/, '').replace(/\s*,\s*/g, ' ').trim();

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

  title = finalParts.join(' ').replace(/\s{2,}/g, ' ').trim();
  
  return title;
}

console.log("Output:", buildSeoTitle(title, specifics));
