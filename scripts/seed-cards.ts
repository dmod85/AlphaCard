import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY!;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY in environment');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

interface CardSetJson {
  id: string;
  name: string;
  year: number;
  brand: string;
  sport: string;
  baseParallels?: { id: string; name: string; odds?: string; printRun?: number }[];
  cards?: { id: string; cardNumber?: string; playerName: string; team?: string; rarity?: string; odds?: string; sport?: string }[];
}

async function seed() {
  const setsDir = path.join(process.cwd(), 'data', 'sets');
  const files = fs.readdirSync(setsDir).filter(f => f.endsWith('.json'));

  console.log(`Found ${files.length} set files`);

  for (const file of files) {
    const raw = fs.readFileSync(path.join(setsDir, file), 'utf-8');
    const json: CardSetJson = JSON.parse(raw);

    // Upsert the set
    const { error: setError } = await supabase.from('card_sets').upsert({
      id: json.id,
      name: json.name,
      year: json.year,
      brand: json.brand,
      sport: json.sport,
      base_parallels: json.baseParallels ?? [],
    });

    if (setError) {
      console.error(`Error upserting set ${json.id}:`, setError.message);
      continue;
    }

    console.log(`  Set: ${json.name}`);

    if (!json.cards || json.cards.length === 0) continue;

    // Upsert cards in batches of 200
    const cards = json.cards.map(c => ({
      id: c.id,
      set_id: json.id,
      card_number: c.cardNumber ?? null,
      player_name: c.playerName,
      team: c.team ?? null,
      rarity: c.rarity ?? null,
      odds: c.odds ?? null,
      sport: c.sport ?? json.sport,
    }));

    for (let i = 0; i < cards.length; i += 200) {
      const batch = cards.slice(i, i + 200);
      const { error } = await supabase.from('cards').upsert(batch);
      if (error) {
        console.error(`  Error upserting cards batch for ${json.id}:`, error.message);
      }
    }

    console.log(`    ${cards.length} cards loaded`);
  }

  console.log('\nDone!');
}

seed().catch(console.error);
