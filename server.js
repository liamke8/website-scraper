// server.js
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const xml2js = require('xml2js');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

/**
 * Adaptive concurrency function to process tasks with dynamic concurrency.
 */
async function processWithAdaptiveConcurrency(tasks, initialConcurrency, maxConcurrency, delayMs) {
    const results = [];
    let index = 0;
    let activeTasks = 0;
    let concurrency = initialConcurrency;
    
    async function worker() {
      while (index < tasks.length) {
        const taskIndex = index++;
        activeTasks++;
        
        try {
          const result = await tasks[taskIndex]();
          results[taskIndex] = result;
        } catch (err) {
          results[taskIndex] = { error: err.message };
          console.error(`Task error: ${err.message}`);
        }
        
        activeTasks--;
        
        // Increase concurrency if possible
        if (activeTasks < concurrency / 2 && concurrency < maxConcurrency) {
          concurrency = Math.min(concurrency + 1, maxConcurrency);
        }
        
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
    
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }
    
    await Promise.all(workers);
    return results;
}

// Home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Add this to server.js
app.post('/api/get-sitemaps', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: 'No URL provided' });
      }
      // Fetch the robots.txt file
      const robotsUrl = new URL('/robots.txt', url).href;
      const response = await axios.get(robotsUrl);
      const robotsTxt = response.data;
      
      // Extract sitemap URLs (simple regex example)
      const sitemapRegex = /Sitemap:\s*(.*)/gi;
      const sitemaps = [];
      let match;
      while ((match = sitemapRegex.exec(robotsTxt)) !== null) {
        sitemaps.push(match[1].trim());
      }
      
      if (sitemaps.length === 0) {
        return res.status(404).json({ error: 'No sitemaps found in robots.txt' });
      }
      
      res.json({ sitemaps });
    } catch (error) {
      console.error('Error fetching robots.txt:', error.message);
      res.status(500).json({ error: 'Failed to fetch sitemaps' });
    }
  });
  

// Get sitemaps from robots.txt
app.post('/api/scrape-content', async (req, res) => {
    try {
      const { urls } = req.body;
      // ... validation and task creation ...
  
      const tasks = urls.map(url => async () => {
        try {
          console.log(`Scraping content from: ${url}`);
          const response = await axios.get(url, { /* options */ });
          const $ = cheerio.load(response.data);
  
          // Remove unwanted elements
          $('script, style, nav, footer, header, aside, .sidebar, .ads, .comments, .navigation, iframe, #cmplz-cookiebanner-container, svg.svg-inline--fa.fa-times.fa-w-11, .elementor-toc').remove();
  
          // <== REPLACE THIS BLOCK with the expanded extraction logic ==>
          let content = $('article').html() || 
                        $('#content').html() || 
                        $('.content').html() || 
                        $('main').html() || 
                        $('.main').html();
          if (!content) {
            content = $('body').html();
          }
          const cleanedHtml = content ? sanitizeHtml(content, $) : '';
          // <== END REPLACE BLOCK ==>
  
          // New CMS-aware extraction code:
          const contentSelectors = [
            'article',                              // Generic articles
            '#content',                             // Common container in many themes
            '.content',                             // Generic content class
            'main',                                 // HTML5 main element
            '.elementor-widget-theme-post-content', // Elementor-based WordPress themes
            'div[data-elementor-type="single-post"]', // Elementor single-post container
            '.entry-content',                       // WordPress default content area
            '.post-content',                        // Alternative WordPress or Joomla selectors
            '.post-body',                           // Some Joomla themes
            '.node-content',                        // Drupal main content
            '.main-content',                        // Generic main content area
            '.page-content',                        // Used in many custom CMS designs
            'div[class*="content"]',                 // Fallback: any div with "content" in its class name
          ];
  
          let extractedContent = '';
          for (let selector of contentSelectors) {
            if ($(selector).length) {
              extractedContent = $(selector).first().html();
              if (extractedContent && extractedContent.trim() !== '') break;
            }
          }
          // Fallback to the entire body if nothing was found.
          if (!extractedContent || extractedContent.trim() === '') {
            extractedContent = $('body').html();
          }
          
          // Clean the extracted HTML using your helper
          const finalCleanedHtml = extractedContent ? sanitizeHtml(extractedContent, $) : '';
          const plainText = $('<div>').html(finalCleanedHtml).text().trim().replace(/\s+/g, ' ');
  
          return {
            url,
            title: $('title').text().trim() || url,
            htmlContent: finalCleanedHtml,
            textContent: plainText
          };
        } catch (error) {
          console.error(`Error scraping ${url}:`, error);
          return {
            url,
            title: url,
            htmlContent: '',
            textContent: '',
            error: error.message
          };
        }
      });
  
      // Use adaptive concurrency to process the tasks
      const scrapedContent = await processWithAdaptiveConcurrency(tasks, 5, 20, 100);
      res.json({ content: scrapedContent });
    } catch (error) {
      console.error('Error in content scraping:', error);
      res.status(500).json({ error: 'Failed to scrape content' });
    }
  });
  

// Get URLs from sitemap
app.post('/api/parse-sitemap', async (req, res) => {
  try {
    const { sitemapUrl } = req.body;
    console.log(`Parsing sitemap: ${sitemapUrl}`);
    const response = await axios.get(sitemapUrl);
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(response.data);
    
    let urls = [];
    
    // Handle sitemap index
    if (result.sitemapindex && result.sitemapindex.sitemap) {
      const sitemaps = Array.isArray(result.sitemapindex.sitemap) 
        ? result.sitemapindex.sitemap 
        : [result.sitemapindex.sitemap];
      console.log(`Sitemap index detected: ${sitemapUrl}, found ${sitemaps.length} child sitemap(s)`);
      res.json({ 
        isSitemapIndex: true, 
        sitemaps: sitemaps.map(sitemap => sitemap.loc)
      });
      return;
    }
    
    // Handle normal sitemap
    if (result.urlset && result.urlset.url) {
      const sitemapUrls = Array.isArray(result.urlset.url) 
        ? result.urlset.url 
        : [result.urlset.url];
      
      urls = sitemapUrls.map(urlObj => ({
        url: urlObj.loc,
        lastmod: urlObj.lastmod || null,
        priority: urlObj.priority || null
      }));
      console.log(`Normal sitemap parsed: ${sitemapUrl}, found ${urls.length} URL(s).`);
    }
    
    res.json({ isSitemapIndex: false, urls });
  } catch (error) {
    console.error('Error parsing sitemap:', error);
    res.status(500).json({ error: 'Failed to parse sitemap' });
  }
});

// Scrape content from URLs
app.post('/api/scrape-content', async (req, res) => {
  try {
    const { urls } = req.body;
    
    // Create a task for each URL
    const tasks = urls.map(url => async () => {
      try {
        console.log(`Scraping content from: ${url}`);
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        
        // Remove unwanted elements
        $('script, style, nav, footer, header, aside, .sidebar, .ads, .comments, .navigation, iframe').remove();
        
        // Extract main content using common selectors
        let content = $('article').html() || 
                      $('#content').html() || 
                      $('.content').html() || 
                      $('main').html() || 
                      $('.main').html();
        if (!content) {
          content = $('body').html();
        }
        
        // Clean up content using sanitizeHtml helper
        const cleanedHtml = content ? sanitizeHtml(content, $) : '';
        const plainText = $.text().trim().replace(/\s+/g, ' ');
        
        return {
          url,
          title: $('title').text().trim() || url,
          htmlContent: cleanedHtml,
          textContent: plainText
        };
      } catch (error) {
        console.error(`Error scraping ${url}:`, error);
        return {
          url,
          title: url,
          htmlContent: '',
          textContent: '',
          error: error.message
        };
      }
    });
    
    // Use the adaptive concurrency function
    const scrapedContent = await processWithAdaptiveConcurrency(tasks, 5, 50, 1);
    res.json({ content: scrapedContent });
  } catch (error) {
    console.error('Error in content scraping:', error);
    res.status(500).json({ error: 'Failed to scrape content' });
  }
});

// Export data
app.post('/api/export', async (req, res) => {
  try {
    const { data, format } = req.body;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    let filename, content;
    
    if (format === 'json') {
      filename = `export-${timestamp}.json`;
      content = JSON.stringify(data, null, 2);
    } else if (format === 'markdown') {
      filename = `export-${timestamp}.md`;
      content = convertToMarkdown(data);
    } else if (format === 'html') {
      filename = `export-${timestamp}.html`;
      content = convertToHTML(data);
    } else if (format === 'txt') {
      filename = `export-${timestamp}.txt`;
      content = convertToPlainText(data);
    } else {
      throw new Error('Unsupported format');
    }
    
    // Create exports directory if it doesn't exist
    const exportDir = path.join(__dirname, 'public', 'exports');
    await fs.mkdir(exportDir, { recursive: true });
    
    const filePath = path.join(exportDir, filename);
    await fs.writeFile(filePath, content);
    
    // Send the file directly to the client instead of just the filename
    res.download(filePath);
  } catch (error) {
    console.error('Error exporting data:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// Helper function to sanitize HTML content
function sanitizeHtml(html, $) {
  const sanitized = $('<div></div>').html(html);
  sanitized.find('script, style, iframe').remove();
  sanitized.find('a').each(function() {
    const a = $(this);
    const href = a.attr('href');
    const text = a.text();
    a.removeAttr();
    if (href) a.attr('href', href);
    if (!a.text().trim()) a.text(text);
  });
  return sanitized.html();
}

// Helper function to clean HTML for LLM consumption.
// Keeps only headings, bold text, lists, and links.
function cleanForLLM(html) {
    if (!html) return '';
    const $ = cheerio.load(html);

    // Allowed tags: headings, strong, b, ul, ol, li, and a
    const allowedTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'ul', 'ol', 'li', 'a']);

    $('*').each(function () {
        const tag = this.tagName.toLowerCase();
        if (!allowedTags.has(tag)) {
        // Replace the element with its inner HTML
        $(this).replaceWith($(this).html() || '');
        }
    });

    // Remove excessive newlines
    let cleaned = $.html();
    cleaned = cleaned.replace(/\n\s*\n/g, '\n').trim();
    return cleaned;
    }

// Convert scraped content to Markdown
function convertToMarkdown(data) {
    let markdown = '# Scraped Content\n\n';
    data.forEach(item => {
      // Use the cleaned HTML
      let content = cleanForLLM(item.htmlContent || '');
      
      // Convert link tags to Markdown links
      content = content.replace(/<a\s+href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');
      // Convert header tags to Markdown headers
      content = content.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n');
      content = content.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n');
      content = content.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n');
      content = content.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n');
      content = content.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n');
      content = content.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n');
      // Convert strong and b tags to Markdown bold
      content = content.replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, '**$2**');
      // Remove any remaining HTML tags
      content = content.replace(/<[^>]+>/g, '');
      // Remove excessive newlines
      content = content.replace(/\n{2,}/g, '\n\n').trim();
      
      markdown += `## ${item.title.trim()}\n\n`;
      markdown += `Source: ${item.url}\n\n`;
      markdown += content + '\n\n---\n\n';
    });
    return markdown;
  }
  

// Convert scraped content to HTML
function convertToHTML(data) {
    let html = `<!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>Scraped Content</title>
    <style>
      body { font-family: Arial, sans-serif; line-height: 1.6; margin: 0; padding: 20px; }
      article { margin-bottom: 40px; border-bottom: 1px solid #eee; padding-bottom: 20px; }
      h1, h2, h3, h4, h5, h6 { margin: 1rem 0; }
      a { color: #0066cc; text-decoration: underline; }
      ul, ol { margin-left: 1.5rem; }
    </style>
  </head>
  <body>
    <h1>Scraped Content</h1>`;
    
    data.forEach(item => {
      let content = cleanForLLM(item.htmlContent || item.textContent || '');
      html += `
    <article>
      <h2>${item.title.trim()}</h2>
      <div>Source: <a href="${item.url}" target="_blank">${item.url}</a></div>
      <div>${content}</div>
    </article>`;
    });
    
    html += `
  </body>
  </html>`;
    return html;
  }
  

// Convert scraped content to plain text
function convertToPlainText(data) {
    let text = 'SCRAPED CONTENT\n\n';
    data.forEach(item => {
      let content = '';
      if (item.htmlContent) {
        content = cleanForLLM(item.htmlContent);
        // Remove any remaining HTML tags for plain text output
        content = content.replace(/<[^>]+>/g, '');
      } else {
        content = item.textContent || '';
      }
      text += `${item.title.trim()}\n`;
      text += `Source: ${item.url}\n\n`;
      text += content + '\n\n';
      text += '---------------------------------------------------\n\n';
    });
    // Remove excessive empty lines
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return text;
  }
  
  async function ensureExportDirectory() {
    const exportDir = path.join(__dirname, 'public', 'exports');
    try {
      await fs.mkdir(exportDir, { recursive: true });
      console.log('Export directory is ready');
    } catch (error) {
      if (error.code !== 'EEXIST') {
        console.error('Error creating export directory:', error);
        throw error;
      }
    }
  }
  

// Start server with improved error handling
(async () => {
  try {
    await ensureExportDirectory();
    
    // Make sure public directory exists
    await fs.mkdir(path.join(__dirname, 'public'), { recursive: true });
    
    // Create or check for index.html
    const indexPath = path.join(__dirname, 'public', 'index.html');
    try {
      await fs.access(indexPath);
      console.log('index.html exists');
    } catch (error) {
      // If index.html doesn't exist, create it from your paste-2.txt
      const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <title>Website Scraper</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
  <h1>Website Content Scraper</h1>
  <p>Please add your HTML content from paste-2.txt here</p>
</body>
</html>`;
      
      await fs.writeFile(indexPath, htmlContent);
      console.log('Created basic index.html');
    }
    
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
})();