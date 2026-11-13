const fs=require('node:fs');
const d=JSON.parse(fs.readFileSync('state/social-v2.json','utf8'));
const g=d.conversations['group:20001'];
console.log('selfNotes:', Array.isArray(g.selfNotes)?g.selfNotes.length:'非数组');
console.log('  ', JSON.stringify(g.selfNotes?.[0]||null).substring(0,120));
console.log();
console.log('memberImpressions:', typeof g.memberImpressions, Object.keys(g.memberImpressions||{}).length);
console.log('  ', JSON.stringify(Object.entries(g.memberImpressions||{})[0]||null).substring(0,150));