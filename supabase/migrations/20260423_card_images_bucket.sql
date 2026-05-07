-- Create the card-images storage bucket for eBay listing photos
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'card-images',
  'card-images',
  true,
  10485760, -- 10 MB
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- Allow anyone to read public images
CREATE POLICY IF NOT EXISTS "card_images_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'card-images');

-- Allow service role (server-side API) to upload
CREATE POLICY IF NOT EXISTS "card_images_service_upload"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'card-images');

-- Allow service role to delete
CREATE POLICY IF NOT EXISTS "card_images_service_delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'card-images');
