const cloudinary = require('cloudinary').v2;
const ImageKit = require('@imagekit/nodejs');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure ImageKit
const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
});

/**
 * Image Router (Bandwidth Sharding)
 * Dynamically shards and routes user uploads to different CDNs based on User ID
 * to combine and pool free tier bandwidth limits.
 */
class ImageRouter {

  /**
   * Determine which Media Shard to use based on User ID.
   * @param {number} userId - ID of the user uploading
   * @returns {string} Shard key ('cloudinary', 'imagekit', 'uploadcare')
   */
  static determineShard(userId) {
    const uId = parseInt(userId) || 1;
    const index = uId % 3;
    if (index === 0) return 'cloudinary';
    if (index === 1) return 'imagekit';
    return 'uploadcare';
  }

  /**
   * Uploads an image base64 string to the allocated Shard CDN.
   * @param {string} fileStr - Base64 image string (e.g. data:image/jpeg;base64,...)
   * @param {number} userId - Uploading User ID
   * @returns {Promise<string>} Secure CDN Image URL
   */
  static async upload(fileStr, userId) {
    const shard = this.determineShard(userId);

    try {
      if (shard === 'cloudinary') {
        const result = await cloudinary.uploader.upload(fileStr, {
          folder: 'absorasocial'
        });
        return result.secure_url;
      }

      if (shard === 'imagekit') {
        const result = await imagekit.upload({
          file: fileStr,
          fileName: `absora_${Date.now()}`
        });
        return result.url;
      }

      if (shard === 'uploadcare') {
        // Parse the base64 string into a Buffer
        const base64Data = fileStr.split(';base64,').pop();
        const buffer = Buffer.from(base64Data, 'base64');
        
        // Build FormData for direct Uploadcare REST API upload
        const formData = new FormData();
        formData.append('UPLOADCARE_PUB_KEY', process.env.UPLOADCARE_PUBLIC_KEY);
        formData.append('UPLOADCARE_STORE', '1');
        
        const fileBlob = new Blob([buffer], { type: 'image/jpeg' });
        formData.append('file', fileBlob, 'upload.jpg');
        
        const response = await fetch('https://upload.uploadcare.com/base/', {
          method: 'POST',
          body: formData
        });
        
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || 'Uploadcare failed');
        return `https://ucarecdn.com/${data.file}/`;
      }
    } catch (error) {
      console.error(`Media Upload Failed on Shard ${shard.toUpperCase()}:`, error.message);
      
      // Automatic Outage Fallback: If primary shard is down, fallback to Cloudinary as emergency
      if (shard !== 'cloudinary') {
        console.warn('Attempting Outage Fallback to Cloudinary...');
        const result = await cloudinary.uploader.upload(fileStr, {
          folder: 'absorasocial_fallback'
        });
        return result.secure_url;
      }
      throw error;
    }
  }
}

module.exports = ImageRouter;
