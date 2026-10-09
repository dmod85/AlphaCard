const fs = require('fs');
let xml = fs.readFileSync('./scratch/get-purchases-output.xml', 'utf8');
if (xml.includes('\0')) {
    xml = fs.readFileSync('./scratch/get-purchases-output.xml', 'utf16le');
}

const itemMatches = [...xml.matchAll(/<Item>[\s\S]*?<Title>(.*?)<\/Title>[\s\S]*?<\/Item>/g)];

let sophieCards = [];
itemMatches.forEach(match => {
    if (match[1].toLowerCase().includes('sophie')) {
        sophieCards.push(match[1]);
    }
});

console.log(`Found ${sophieCards.length} Sophie cards:`);
sophieCards.forEach(card => console.log(`- ${card}`));
