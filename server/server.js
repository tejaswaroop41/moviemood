import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());

// ✅ Points to ../frontend (sibling folder of server/)
app.use(express.static(join(__dirname, "public")));

const TMDB = "https://api.themoviedb.org/3";
const KEY  = process.env.TMDB_API_KEY;

if (!KEY) {
  console.error("❌ TMDB_API_KEY missing in .env!");
  process.exit(1);
}

// ─── SAFE FETCH: retries + ECONNRESET handling ───
async function safeFetch(url, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await axios.get(url, {
        timeout: 10000,
        headers: { "Accept-Encoding": "gzip" }
      });
      return res.data;
    } catch (e) {
      const status  = e?.response?.status;
      const code    = e?.code;
      const isRetry = code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND";

      console.warn(`⚠️  FAIL [${i + 1}/${retries + 1}] → ${status || code || e.message}`);

      if (status === 401) { console.error("❌ Invalid API Key"); return null; }
      if (status === 404) return null;
      if (i === retries)  return null;

      const delay = isRetry ? 1000 * (i + 1) : 400 * (i + 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ─── MOOD MAP ───
const moodMap = {
  happy:     "35,10751",
  sad:       "18",
  thriller:  "53,80",
  romantic:  "10749",
  action:    "28",
  scifi:     "878",
  horror:    "27",
  animation: "16"
};

// 🎭 MOODS
app.get("/api/mood/:type", async (req, res) => {
  const genres = moodMap[req.params.type];
  if (!genres) return res.status(400).json({ error: "Unknown mood" });

  const data = await safeFetch(
    `${TMDB}/discover/movie?api_key=${KEY}&with_genres=${genres}&sort_by=popularity.desc&page=1`
  );
  res.json(data?.results || []);
});

// 🔥 TRENDING
app.get("/api/trending", async (req, res) => {
  const data = await safeFetch(`${TMDB}/trending/movie/week?api_key=${KEY}`);
  res.json(data?.results || []);
});

// ⭐ TOP RATED
app.get("/api/top", async (req, res) => {
  const data = await safeFetch(`${TMDB}/movie/top_rated?api_key=${KEY}&region=IN`);
  res.json(data?.results || []);
});

// 🌍 BOLLYWOOD + TOLLYWOOD
app.get("/api/movies", async (req, res) => {
  const urls = [
    `${TMDB}/discover/movie?api_key=${KEY}&with_original_language=hi&sort_by=popularity.desc`,
    `${TMDB}/discover/movie?api_key=${KEY}&with_original_language=te&sort_by=popularity.desc`,
    `${TMDB}/trending/movie/week?api_key=${KEY}`
  ];

  let all = [];
  for (const url of urls) {
    const d = await safeFetch(url);
    if (d?.results) all = all.concat(d.results);
  }

  const seen   = new Set();
  const unique = all.filter(m => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  res.json(unique.slice(0, 40));
});

// 🔍 SEARCH
app.get("/api/search", async (req, res) => {
  const q = req.query.q?.trim();
  if (!q || q.length < 2) return res.json([]);

  const data = await safeFetch(
    `${TMDB}/search/movie?api_key=${KEY}&query=${encodeURIComponent(q)}&include_adult=false`
  );
  res.json(data?.results || []);
});

// 🎯 MOVIE DETAILS + SMART RECOMMENDATIONS
app.get("/api/movie/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid movie ID" });

  const [details, similar, recommendations, credits] = await Promise.all([
    safeFetch(`${TMDB}/movie/${id}?api_key=${KEY}&append_to_response=videos`),
    safeFetch(`${TMDB}/movie/${id}/similar?api_key=${KEY}`),
    safeFetch(`${TMDB}/movie/${id}/recommendations?api_key=${KEY}`),
    safeFetch(`${TMDB}/movie/${id}/credits?api_key=${KEY}`)
  ]);

  if (!details) return res.status(404).json({ error: "Movie not found" });

  // Merge & deduplicate
  const seen = new Set([id]);
  const recs = [];

  for (const m of [...(recommendations?.results || []), ...(similar?.results || [])]) {
    if (!seen.has(m.id) && m.poster_path) {
      seen.add(m.id);
      recs.push(m);
    }
  }

  // Fallback 1: director's other movies
  if (recs.length < 8 && credits?.crew) {
    const director = credits.crew.find(c => c.job === "Director");
    if (director) {
      const dirMovies = await safeFetch(
        `${TMDB}/person/${director.id}/movie_credits?api_key=${KEY}`
      );
      for (const m of (dirMovies?.cast || [])) {
        if (!seen.has(m.id) && m.poster_path) {
          seen.add(m.id);
          recs.push(m);
        }
      }
    }
  }

  // Fallback 2: genre-based discovery
  if (recs.length < 8 && details?.genres?.length) {
    const genreIds = details.genres.map(g => g.id).join(",");
    const [byPop, byRating] = await Promise.all([
      safeFetch(`${TMDB}/discover/movie?api_key=${KEY}&with_genres=${genreIds}&sort_by=popularity.desc&vote_count.gte=50`),
      safeFetch(`${TMDB}/discover/movie?api_key=${KEY}&with_genres=${genreIds}&sort_by=vote_average.desc&vote_count.gte=100`)
    ]);
    for (const m of [...(byPop?.results || []), ...(byRating?.results || [])]) {
      if (!seen.has(m.id) && m.poster_path) {
        seen.add(m.id);
        recs.push(m);
      }
    }
  }

  recs.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));

  const trailer = details?.videos?.results?.find(
    v => v.type === "Trailer" && v.site === "YouTube"
  ) || details?.videos?.results?.find(v => v.site === "YouTube");

  res.json({
    details,
    recommendations: recs.slice(0, 20),
    cast:  credits?.cast?.slice(0, 10) || [],
    crew:  credits?.crew
             ?.filter(c => ["Director", "Screenplay", "Story", "Writer"].includes(c.job))
             ?.slice(0, 4) || [],
    trailerKey: trailer?.key || null
  });
});

// ❤️ Health check
app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date() }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🎬 MovieMood running → http://localhost:${PORT}`));