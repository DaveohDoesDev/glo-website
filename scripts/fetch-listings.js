/**
 * Spark MLS Data Fetcher
 *
 * Fetches active listings from the Spark Platform API for the Space Coast / Brevard County area.
 * Writes results to data/listings.json and data/featured.json.
 *
 * Usage:
 *   SPARK_API_TOKEN=<token> node scripts/fetch-listings.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://sparkapi.com/v1';
const TOKEN = process.env.SPARK_API_TOKEN;

if (!TOKEN) {
  console.error('Error: SPARK_API_TOKEN environment variable is required.');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, '..', 'data');

// Space Coast cities to include
const CITIES = [
  'Viera', 'Melbourne', 'Suntree', 'Rockledge',
  'Merritt Island', 'Melbourne Beach', 'Indialantic',
  'Satellite Beach', 'Indian Harbour Beach', 'Palm Bay',
  'Cocoa Beach', 'Cape Canaveral', 'Titusville'
];

function sparkRequest(endpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, API_BASE);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`API returned ${res.statusCode}: ${body.slice(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Failed to parse API response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

function buildCityFilter() {
  return CITIES.map(city => `City Eq '${city}'`).join(' Or ');
}

async function fetchListings() {
  const allListings = [];
  let page = 1;
  const pageSize = 50;
  let hasMore = true;

  console.log('Fetching active listings from Spark API...');

  while (hasMore) {
    const filter = `MlsStatus Eq 'Active' And (${buildCityFilter()})`;
    const params = new URLSearchParams({
      '_expand': 'Photos,Videos,VirtualTours',
      '_filter': filter,
      '_limit': String(pageSize),
      '_page': String(page),
      '_orderby': '-ListPrice'
    });

    const endpoint = `/v1/listings?${params.toString()}`;
    console.log(`  Fetching page ${page}...`);

    try {
      const data = await sparkRequest(endpoint);
      const results = data.D?.Results || [];

      if (results.length === 0) {
        hasMore = false;
        break;
      }

      allListings.push(...results);
      console.log(`  Got ${results.length} listings (total: ${allListings.length})`);

      // Check pagination
      const pagination = data.D?.Pagination;
      if (pagination && pagination.TotalPages && page < pagination.TotalPages) {
        page++;
      } else {
        hasMore = false;
      }

      // Respect rate limits - small delay between pages
      if (hasMore) {
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err) {
      console.error(`  Error fetching page ${page}: ${err.message}`);
      hasMore = false;
    }
  }

  return allListings;
}

function transformListing(raw) {
  const photos = (raw.Photos || raw.Media || []).map(photo => ({
    url: photo.Uri1600 || photo.Uri1280 || photo.Uri800 || photo.UriLarge || photo.Uri640 || photo.Uri300 || '',
    thumbUrl: photo.Uri300 || photo.Uri640 || '',
    caption: photo.Caption || ''
  })).filter(p => p.url);

  const videos = (raw.Videos || []).map(v => ({
    url: v.ObjectHtml || v.Uri || '',
    caption: v.Caption || ''
  })).filter(v => v.url);

  const virtualTours = (raw.VirtualTours || []).map(vt => ({
    url: vt.Uri || '',
    caption: vt.Caption || ''
  })).filter(vt => vt.url);

  return {
    id: raw.ListingKey || raw.Id || '',
    mlsId: raw.ListingId || '',
    status: raw.MlsStatus || raw.StandardStatus || 'Active',
    price: raw.ListPrice || 0,
    address: {
      full: raw.UnparsedAddress || `${raw.StreetNumber || ''} ${raw.StreetName || ''} ${raw.StreetSuffix || ''}`.trim(),
      city: raw.City || '',
      state: raw.StateOrProvince || 'FL',
      zip: raw.PostalCode || '',
      county: raw.CountyOrParish || 'Brevard'
    },
    details: {
      beds: raw.BedroomsTotal || 0,
      baths: raw.BathroomsFull || 0,
      halfBaths: raw.BathroomsHalf || 0,
      sqft: raw.LivingArea || raw.BuildingAreaTotal || 0,
      lotSize: raw.LotSizeAcres || raw.LotSizeArea || 0,
      yearBuilt: raw.YearBuilt || null,
      propertyType: raw.PropertyType || '',
      propertySubType: raw.PropertySubType || '',
      garage: raw.GarageSpaces || 0,
      pool: raw.PoolPrivateYN || false,
      waterfront: raw.WaterfrontYN || false
    },
    description: raw.PublicRemarks || '',
    photos: photos,
    videos: videos,
    virtualTours: virtualTours,
    location: {
      lat: raw.Latitude || null,
      lng: raw.Longitude || null
    },
    listDate: raw.ListingContractDate || raw.OnMarketDate || '',
    modifiedDate: raw.ModificationTimestamp || '',
    agent: {
      name: raw.ListAgentFullName || '',
      office: raw.ListOfficeName || ''
    }
  };
}

function selectFeatured(listings, count = 6) {
  // Pick highest-priced listings that have photos as featured
  return listings
    .filter(l => l.photos.length > 0 && l.price > 0)
    .sort((a, b) => b.price - a.price)
    .slice(0, count);
}

async function main() {
  try {
    const rawListings = await fetchListings();
    console.log(`\nTotal raw listings fetched: ${rawListings.length}`);

    const listings = rawListings.map(transformListing);
    console.log(`Transformed ${listings.length} listings`);

    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Write all listings
    const listingsPath = path.join(DATA_DIR, 'listings.json');
    fs.writeFileSync(listingsPath, JSON.stringify({
      lastUpdated: new Date().toISOString(),
      count: listings.length,
      listings: listings
    }, null, 2));
    console.log(`Wrote ${listings.length} listings to ${listingsPath}`);

    // Write featured subset
    const featured = selectFeatured(listings);
    const featuredPath = path.join(DATA_DIR, 'featured.json');
    fs.writeFileSync(featuredPath, JSON.stringify({
      lastUpdated: new Date().toISOString(),
      count: featured.length,
      listings: featured
    }, null, 2));
    console.log(`Wrote ${featured.length} featured listings to ${featuredPath}`);

  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
}

main();
