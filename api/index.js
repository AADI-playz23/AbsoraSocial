// AbsoraSocial Consolidated Serverless API Router
// Compiles into a single Serverless Function to bypass Vercel Hobby plan limit!

const routes = {
    auth: require('./_auth'),
    cleanup: require('./_cleanup'),
    explore: require('./_explore'),
    messages: require('./_messages'),
    notifications: require('./_notifications'),
    posts: require('./_posts'),
    'sign-upload': require('./_sign-upload'),
    stories: require('./_stories'),
    upload: require('./_upload'),
    users: require('./_users'),
    'ws-config': require('./_ws-config')
};

module.exports = async (req, res) => {
    // Parse target path from request URL
    const urlPath = req.url || '';
    const parsedPath = urlPath.split('?')[0].replace(/^\/api\//, '').replace(/^\//, '');
    const firstSegment = parsedPath.split('/')[0];

    const handler = routes[firstSegment];
    if (handler) {
        try {
            return await handler(req, res);
        } catch (err) {
            console.error(`Error handling route ${firstSegment}:`, err);
            return res.status(500).json({ error: 'Internal Server Error' });
        }
    }

    return res.status(404).json({ error: `Route not found: ${firstSegment}` });
};
