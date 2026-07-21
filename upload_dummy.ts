import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'

// Read env variables
const envPath = path.resolve('.env.local')
const envContent = fs.readFileSync(envPath, 'utf-8')

const env = envContent.split('\n').reduce((acc, line) => {
  const match = line.match(/^([^#=]+)=(.*)$/)
  if (match) {
    acc[match[1].trim()] = match[2].trim()
  }
  return acc
}, {} as Record<string, string>)

const supabaseUrl = env['NEXT_PUBLIC_SUPABASE_URL']
const supabaseKey = env['SUPABASE_SECRET_KEY']

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials in environment");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function run() {
  const imagePath = path.resolve('dummy_floor_plan.png')
  const fileBuffer = fs.readFileSync(imagePath)

  // Ensure hospital test1 exists
  await supabase.from('hospitals').upsert({ id: 'test1', name: 'Test Hospital 1', floors: 1 })

  // 1. Upload to storage
  const { data: uploadData, error: uploadError } = await supabase
    .storage
    .from('floor-plans')
    .upload('test1/1.png', fileBuffer, {
      contentType: 'image/png',
      upsert: true
    })

  if (uploadError) {
    console.error('Error uploading image:', uploadError)
    process.exit(1)
  }

  // 2. Get public URL
  const { data: { publicUrl } } = supabase
    .storage
    .from('floor-plans')
    .getPublicUrl('test1/1.png')

  console.log('Public URL:', publicUrl)

  // 3. Upsert into floors table
  const { data: floorData, error: floorError } = await supabase
    .from('floors')
    .upsert({
      hospital_id: 'test1',
      floor_number: 1,
      floor_plan_url: publicUrl,
      scale_mpp: 0.05 // default dummy scale
    })

  if (floorError) {
    console.error('Error upserting floor record:', floorError)
  } else {
    console.log('Successfully uploaded and created floor record!')
  }
}

run()
