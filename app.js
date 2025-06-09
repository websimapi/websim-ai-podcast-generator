import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { useQuery } from '@websim/use-query';
import { WebsimSocket } from '@websim/websim-socket';
import { motion, AnimatePresence } from 'framer-motion';

// --- DATABASE AND WEBSIM SETUP ---

const room = new WebsimSocket({
  schema: {
    podcasts: {
      id: "uuid",
      creator_id: "uuid",
      topic: "text",
      status: "text", // GENERATING, COMPLETE, FAILED
      script: "jsonb",
      host_name: "text",
      guest_name: "text",
      host_avatar_url: "text",
      guest_avatar_url: "text",
      audio_url: "text",
      created_at: "timestamptz",
    },
    podcast_assets: {
      id: "uuid",
      podcast_id: "uuid",
      asset_type: "text", // 'audio_segment', 'slideshow_image'
      segment_index: "integer",
      url: "text",
      description: "text",
    },
    podcast_upvotes: {
      id: "text", // user_id + podcast_id
      podcast_id: "uuid",
      user_id: "uuid",
    },
    generation_lock: {
      id: "text", // A fixed ID e.g. 'generation_lock_v1'
      user_id: "uuid",
      username: "text",
      status_message: "text",
      progress: "numeric", // 0-100
      updated_at: "timestamptz",
    },
  },
});

const LOCK_ID = 'generation_lock_v1';
const DRAFT_STORAGE_KEY = 'podcast-draft';

// --- UTILITY AND HELPER FUNCTIONS ---

/**
 * A robust fetch-like function with retry mechanism (exponential backoff + jitter).
 * @param {Function} asyncFn The async function to execute.
 * @param {number} retries Maximum number of retries.
 * @param {Function} onRetry A callback function to call on each retry attempt.
 * @returns {Promise<any>}
 */
const withRetry = async (asyncFn, retries = 5, onRetry = null) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await asyncFn();
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error);
      if (onRetry) onRetry(i + 1, error);
      if (i === retries - 1) throw new Error(`Operation failed after ${retries} attempts: ${error.message}`);
      const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
      await new Promise(res => setTimeout(res, delay));
    }
  }
};

/**
 * Generates distinct voices for speakers.
 * @param {string} speakerName The name of the speaker.
 * @param {string} gender The gender of the speaker ('male' or 'female').
 * @returns {string} A voice code for the TTS API.
 */
const getVoiceForSpeaker = (speakerName, gender) => {
    const languages = ['en', 'es', 'fr', 'de', 'it', 'pt'];
    const hash = speakerName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const lang = languages[hash % languages.length];
    return `${lang}-${gender}`;
};

/**
 * Saves a draft of the podcast generation state to localStorage.
 * @param {object} draftState The state to save.
 */
const saveDraft = (draftState) => {
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draftState));
  } catch (e) {
    console.error("Failed to save draft:", e);
  }
};

/**
 * Loads a draft from localStorage.
 * @returns {object|null} The loaded draft state.
 */
const loadDraft = () => {
  try {
    const draft = localStorage.getItem(DRAFT_STORAGE_KEY);
    return draft ? JSON.parse(draft) : null;
  } catch (e) {
    console.error("Failed to load draft:", e);
    return null;
  }
};

/**
 * Clears the draft from localStorage.
 */
const clearDraft = () => {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
};


// --- REACT COMPONENTS ---

// Spinner Component
const Spinner = () => (
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-400"></div>
);

// Generation Progress Modal
const GenerationModal = ({ lock }) => {
    if (!lock) return null;

    return (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
            <div className="bg-gray-800 p-8 rounded-lg shadow-xl text-center max-w-md">
                <h2 className="text-2xl font-bold mb-4">Podcast Generation in Progress</h2>
                <p className="mb-2 text-gray-300">
                    <span className="font-semibold">{lock.username}</span> is creating a new podcast. Please wait.
                </p>
                <div className="w-full bg-gray-700 rounded-full h-4 mb-4 overflow-hidden">
                    <div className="bg-blue-600 h-4 rounded-full" style={{ width: `${lock.progress || 0}%` }}></div>
                </div>
                <p className="text-sm text-gray-400">{lock.status_message}</p>
            </div>
        </div>
    );
};

// Podcast Player Component
const PodcastPlayer = ({ podcastId, onBack }) => {
    const { data: podcastDataArr } = useQuery(room.collection('podcasts').filter({ id: podcastId }));
    const { data: assets } = useQuery(room.collection('podcast_assets').filter({ podcast_id: podcastId }));
    const podcast = podcastDataArr?.[0];

    const audioRef = useRef(null);
    const [currentSegment, setCurrentSegment] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);

    const images = assets?.filter(a => a.asset_type === 'slideshow_image').sort((a, b) => a.segment_index - b.segment_index) || [];
    const audioSegments = assets?.filter(a => a.asset_type === 'audio_segment').sort((a, b) => a.segment_index - b.segment_index) || [];

    useEffect(() => {
        if (!audioRef.current || audioSegments.length === 0) return;
        
        const audio = audioRef.current;
        const playNextSegment = () => {
            if (currentSegment < audioSegments.length -1) {
                setCurrentSegment(s => s + 1);
            } else {
                setIsPlaying(false);
            }
        };

        audio.addEventListener('ended', playNextSegment);
        return () => audio.removeEventListener('ended', playNextSegment);
    }, [audioRef, audioSegments, currentSegment]);

    useEffect(() => {
       if(isPlaying && audioRef.current && audioSegments[currentSegment]) {
           audioRef.current.src = audioSegments[currentSegment].url;
           audioRef.current.play().catch(e => console.error("Audio play failed:", e));
       }
    }, [currentSegment, isPlaying, audioSegments]);

    const togglePlay = () => {
        if(isPlaying) {
            audioRef.current.pause();
            setIsPlaying(false);
        } else {
            setIsPlaying(true);
        }
    };
    
    if (!podcast) return <div className="flex justify-center items-center h-screen"><Spinner /></div>;

    if (!podcast.script || !podcast.script.segments || !Array.isArray(podcast.script.segments)) {
        return (
            <div className="p-4 md:p-8 max-w-5xl mx-auto">
                <button onClick={onBack} className="mb-4 bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg">&larr; Back to Podcasts</button>
                <div className="bg-gray-800 rounded-lg shadow-xl overflow-hidden p-6 text-center">
                    <h2 className="text-2xl font-bold text-red-500">Error Loading Podcast</h2>
                    <p className="text-gray-300 mt-2">The podcast data appears to be missing or corrupted. It might have failed during generation.</p>
                </div>
            </div>
        );
    }

    const currentImageIndex = Math.floor(currentSegment / 2);
    const currentImage = images[currentImageIndex];
    const speakingSegment = podcast.script.segments[currentSegment];
    
    return (
        <div className="p-4 md:p-8 max-w-5xl mx-auto">
            <button onClick={onBack} className="mb-4 bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg">&larr; Back to Podcasts</button>
            <div className="bg-gray-800 rounded-lg shadow-xl overflow-hidden">
                <div className="p-6">
                    <h2 className="text-3xl font-bold">{podcast.script.title}</h2>
                    <p className="text-gray-400">By {podcast.creator_username || 'Unknown'}</p>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 p-6">
                    <div className="md:col-span-2">
                        {currentImage ? (
                            <div className="aspect-video bg-black rounded-lg flex items-center justify-center group relative">
                                <img src={currentImage.url} alt={currentImage.description} className="max-h-full max-w-full object-contain"/>
                                <div className="absolute inset-0 bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center p-4">
                                    <p className="text-white text-center text-sm">{currentImage.description}</p>
                                </div>
                            </div>
                        ) : <div className="aspect-video bg-black rounded-lg flex items-center justify-center"><p>Slideshow will appear here</p></div>}
                    </div>

                    <div className="flex flex-col items-center justify-around">
                        {[
                            { name: podcast.host_name, avatar: podcast.host_avatar_url },
                            { name: podcast.guest_name, avatar: podcast.guest_avatar_url }
                        ].map(speaker => (
                            <div key={speaker.name} className={`text-center p-2 transition-all duration-300 ${speakingSegment?.speaker === speaker.name ? 'speaking-avatar' : 'notspeaking-avatar'}`}>
                                <img src={speaker.avatar || 'default-avatar.png'} alt={speaker.name} className="w-24 h-24 rounded-full mx-auto border-4 border-gray-600"/>
                                <p className="mt-2 font-bold">{speaker.name}</p>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="p-6">
                    <div className="flex items-center justify-center mb-4">
                        <button onClick={togglePlay} className="bg-blue-600 hover:bg-blue-500 text-white rounded-full w-16 h-16 flex items-center justify-center text-3xl">
                           <i className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'}`}></i>
                        </button>
                        <audio ref={audioRef} />
                    </div>
                    
                    <div className="h-48 bg-gray-900 rounded-lg p-4 overflow-y-auto transcript-container">
                        {podcast.script.segments.map((segment, index) => (
                            <div key={index} className={`p-2 rounded transition-colors ${index === currentSegment ? 'bg-blue-900 bg-opacity-50' : ''}`}>
                                <p><span className="font-bold">{segment.speaker}:</span> {segment.line}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};


// Podcast Generator Component
const PodcastGenerator = ({ currentUser }) => {
    const [topic, setTopic] = useState('');
    const [hostName, setHostName] = useState('Host');
    const [guestName, setGuestName] = useState('Guest');
    const [hostImg, setHostImg] = useState(null);
    const [guestImg, setGuestImg] = useState(null);
    
    const [status, setStatus] = useState('');
    const [progress, setProgress] = useState(0);
    const [isGenerating, setIsGenerating] = useState(false);
    const [voiceCloneDisclaimer, setVoiceCloneDisclaimer] = useState(false);
    const [hostVoiceSample, setHostVoiceSample] = useState(null);
    const [guestVoiceSample, setGuestVoiceSample] = useState(null);

    // Load draft on mount
    useEffect(() => {
        const draft = loadDraft();
        if(draft) {
            if(confirm("You have an unfinished podcast draft. Do you want to resume?")) {
                setTopic(draft.topic || '');
                setHostName(draft.hostName || 'Host');
                setGuestName(draft.guestName || 'Guest');
                // Note: File inputs cannot be programmatically restored for security reasons.
                setStatus('Resumed from draft. Ready to continue generation.');
            } else {
                clearDraft();
            }
        }
    }, []);

    const updateGenerationStatus = async (message, percent) => {
        setStatus(message);
        setProgress(percent);
        await room.collection('generation_lock').upsert({
            id: LOCK_ID,
            user_id: currentUser.id,
            username: currentUser.username,
            status_message: message,
            progress: percent,
            updated_at: new Date().toISOString(),
        });
    };

    const handleGenerate = async () => {
        if (!topic.trim()) {
            alert("Please enter a topic for the podcast.");
            return;
        }

        setIsGenerating(true);
        let podcastRecord;

        try {
            // Step 1: Acquire Lock
            await updateGenerationStatus("Acquiring generation lock...", 0);
            await room.collection('generation_lock').upsert({
                id: LOCK_ID,
                user_id: currentUser.id,
                username: currentUser.username,
                status_message: 'Initializing...',
                progress: 5,
                updated_at: new Date().toISOString(),
            });

            // Save draft
            saveDraft({ topic, hostName, guestName });
            
            // Step 2: Generate script
            await updateGenerationStatus("Generating script...", 10);
            const scriptResponse = await withRetry(() => websim.chat.completions.create({
                messages: [
                    { role: "system", content: `You are a podcast script writer. Create a short, engaging podcast script about "${topic}". The podcast has a host named "${hostName}" and a guest named "${guestName}". The script should have exactly 10 segments, alternating between the host and guest. Start with the host. Respond with only JSON in this format: {"title": "Podcast Title", "segments": [{"speaker": "${hostName} or ${guestName}", "line": "dialogue"}]}` },
                ],
                json: true,
            }));
            
            let scriptData;
            try {
                scriptData = JSON.parse(scriptResponse.content);
            } catch (e) {
                console.error("Failed to parse script JSON:", scriptResponse.content);
                throw new Error("Could not parse script data after multiple attempts.");
            }
            
            // Fix speaker alternation if LLM failed
            scriptData.segments.forEach((seg, i) => {
                if (i > 0 && seg.speaker === scriptData.segments[i-1].speaker) {
                    seg.speaker = seg.speaker === hostName ? guestName : hostName;
                }
            });


            await updateGenerationStatus("Generating avatars...", 25);
            const generateAvatar = async (name, role, customImg) => {
                 return await withRetry(async () => {
                    let prompt = `A professional portrait of ${name}, a podcast ${role}. Vibrant, character art style. transparent background.`;
                    const messages = [{
                        role: "user",
                        content: [{type: "text", text: prompt}]
                    }];

                    if(customImg) {
                       const customImgUrl = await websim.upload(customImg);
                       messages[0].content.push({type: "image_url", image_url: {url: customImgUrl}});
                    }
                    const { url } = await websim.imageGen({ prompt: JSON.stringify(messages), transparent: true });
                    return url;
                }, 3, () => updateGenerationStatus(`Retrying avatar for ${name}...`, 25));
            };

            const hostAvatarUrl = await generateAvatar(hostName, 'host', hostImg).catch(() => 'default-avatar.png');
            const guestAvatarUrl = await generateAvatar(guestName, 'guest', guestImg).catch(() => 'default-avatar.png');

            // Create podcast record in DB
            podcastRecord = await room.collection('podcasts').create({
                creator_id: currentUser.id,
                topic,
                status: 'GENERATING',
                script: scriptData,
                host_name: hostName,
                guest_name: guestName,
                host_avatar_url: hostAvatarUrl,
                guest_avatar_url: guestAvatarUrl,
            });
            saveDraft({ topic, hostName, guestName, scriptData, hostAvatarUrl, guestAvatarUrl, podcastId: podcastRecord.id });

            // Step 3: Generate audio
            for (let i = 0; i < scriptData.segments.length; i++) {
                const segment = scriptData.segments[i];
                await updateGenerationStatus(`Generating audio for segment ${i+1}/${scriptData.segments.length}...`, 40 + (i * 3));
                
                let voiceOptions = {};
                if (segment.speaker === hostName && hostVoiceSample) {
                    voiceOptions.voice_sample = await websim.upload(hostVoiceSample);
                } else if (segment.speaker === guestName && guestVoiceSample) {
                    voiceOptions.voice_sample = await websim.upload(guestVoiceSample);
                } else {
                    voiceOptions.voice = getVoiceForSpeaker(segment.speaker, segment.speaker === hostName ? 'female' : 'male');
                }

                const audioResponse = await withRetry(() => websim.textToSpeech({ text: segment.line, ...voiceOptions }));
                await room.collection('podcast_assets').create({
                    podcast_id: podcastRecord.id,
                    asset_type: 'audio_segment',
                    segment_index: i,
                    url: audioResponse.url,
                    description: `Audio for: ${segment.line}`
                });
            }

            // Step 4: Generate slideshow images
            for (let i = 0; i < scriptData.segments.length; i += 2) {
                const combinedLines = `${scriptData.segments[i].line} ${scriptData.segments[i+1]?.line || ''}`;
                await updateGenerationStatus(`Generating image for slides ${i/2 + 1}/${Math.ceil(scriptData.segments.length/2)}...`, 70 + (i * 3));
                const imagePromptResponse = await withRetry(() => websim.chat.completions.create({
                    messages: [{ role: 'system', content: `Generate a short, creative, descriptive image prompt for a slideshow, based on this dialogue: "${combinedLines}". The image should be visually interesting and abstract. Do not use any quotes in your response.`},],
                }));
                const imagePrompt = imagePromptResponse.content;
                const imageResponse = await withRetry(() => websim.imageGen({ prompt: imagePrompt, aspect_ratio: "16:9" }));

                await room.collection('podcast_assets').create({
                    podcast_id: podcastRecord.id,
                    asset_type: 'slideshow_image',
                    segment_index: i,
                    url: imageResponse.url,
                    description: imagePrompt
                });
            }
            
            await updateGenerationStatus("Finalizing podcast...", 95);
            await room.collection('podcasts').upsert({ id: podcastRecord.id, status: 'COMPLETE' });

            await updateGenerationStatus("Podcast generation complete!", 100);
            clearDraft();

        } catch (error) {
            console.error("Podcast generation failed:", error);
            setStatus(`Error: ${error.message}`);
            if (podcastRecord) {
                await room.collection('podcasts').upsert({ id: podcastRecord.id, status: 'FAILED' });
            }
        } finally {
            setIsGenerating(false);
            // Release lock
            await room.collection('generation_lock').delete(LOCK_ID);
        }
    };
    
    return (
        <div className="max-w-2xl mx-auto p-4 md:p-8">
            <h1 className="text-3xl font-bold mb-6 text-center">Create AI Podcast</h1>
            <div className="space-y-4 bg-gray-800 p-6 rounded-lg shadow-lg">
                <div>
                    <label className="block mb-2 text-sm font-medium text-gray-300">Podcast Topic</label>
                    <input type="text" value={topic} onChange={e => setTopic(e.target.value)} placeholder="e.g., The Future of Artificial Intelligence" />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label className="block mb-2 text-sm font-medium">Host Name</label>
                        <input type="text" value={hostName} onChange={e => setHostName(e.target.value)} />
                    </div>
                    <div>
                        <label className="block mb-2 text-sm font-medium">Guest Name</label>
                        <input type="text" value={guestName} onChange={e => setGuestName(e.target.value)} />
                    </div>
                </div>
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label className="block mb-2 text-sm font-medium">Host Custom Avatar (Optional)</label>
                        <input type="file" accept="image/*" onChange={e => setHostImg(e.target.files[0])} />
                    </div>
                    <div>
                        <label className="block mb-2 text-sm font-medium">Guest Custom Avatar (Optional)</label>
                        <input type="file" accept="image/*" onChange={e => setGuestImg(e.target.files[0])} />
                    </div>
                </div>
                 <div className="p-4 border border-yellow-400 rounded-lg bg-yellow-900 bg-opacity-20">
                    <h3 className="font-bold text-yellow-300">Voice Cloning (Optional)</h3>
                    {!voiceCloneDisclaimer && (
                        <div>
                            <p className="text-sm text-yellow-200 mt-2">By using voice cloning, you acknowledge that you have obtained the necessary permissions to use the cloned voice and agree not to use it for malicious or deceptive purposes.</p>
                            <button onClick={() => setVoiceCloneDisclaimer(true)} className="mt-2 bg-yellow-500 hover:bg-yellow-600 text-white px-3 py-1 rounded text-sm">I Understand and Agree</button>
                        </div>
                    )}
                    {voiceCloneDisclaimer && (
                       <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                           <div>
                                <label className="block mb-2 text-sm font-medium">Host Voice Sample (.wav, .mp3)</label>
                                <input type="file" accept="audio/*" onChange={e => setHostVoiceSample(e.target.files[0])} />
                           </div>
                           <div>
                                <label className="block mb-2 text-sm font-medium">Guest Voice Sample (.wav, .mp3)</label>
                                <input type="file" accept="audio/*" onChange={e => setGuestVoiceSample(e.target.files[0])} />
                           </div>
                       </div>
                    )}
                </div>
                <button
                    onClick={handleGenerate}
                    disabled={isGenerating}
                    className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-500 text-white font-bold py-3 px-4 rounded-lg transition-colors"
                >
                    {isGenerating ? "Generating..." : "Generate Podcast"}
                </button>
                {status && (
                    <div className="text-center text-gray-300 mt-4">
                        <p>{status}</p>
                        {isGenerating && <div className="w-full bg-gray-700 rounded-full h-2.5 mt-2"><div className="bg-blue-600 h-2.5 rounded-full" style={{width: `${progress}%`}}></div></div>}
                    </div>
                )}
            </div>
        </div>
    );
};

// Podcast List Component
const PodcastList = ({ onSelectPodcast, currentUser, filter }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [sortBy, setSortBy] = useState('upvotes');

    const query = useQuery(room.query(`
        WITH upvote_counts AS (
            SELECT podcast_id, count(*) as votes FROM public.podcast_upvotes GROUP BY podcast_id
        )
        SELECT 
            p.id, p.topic, p.status, p.created_at, p.creator_id,
            u.username as creator_username,
            COALESCE(uc.votes, 0) as upvote_count
        FROM public.podcasts p
        JOIN public.user u ON p.creator_id = u.id
        LEFT JOIN upvote_counts uc ON p.id = uc.podcast_id
        WHERE p.status = 'COMPLETE'
        ORDER BY ${sortBy === 'upvotes' ? 'upvote_count' : 'created_at'} DESC
    `));
    const { data: podcasts, loading } = query;

    const { data: myUpvotesData } = useQuery(room.collection('podcast_upvotes').filter({user_id: currentUser?.id}));
    const myUpvotes = new Set(myUpvotesData?.map(v => v.podcast_id));
    
    const handleUpvote = async (podcastId) => {
        if (!currentUser) return;
        const upvoteId = `${currentUser.id}-${podcastId}`;
        if(myUpvotes.has(podcastId)) {
            await room.collection('podcast_upvotes').delete(upvoteId);
        } else {
            await room.collection('podcast_upvotes').upsert({
                id: upvoteId,
                podcast_id: podcastId,
                user_id: currentUser.id,
            });
        }
    };
    
    const filteredPodcasts = podcasts?.filter(p => {
        const matchesSearch = p.topic.toLowerCase().includes(searchTerm.toLowerCase()) || p.creator_username.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesFilter = !filter || (filter === 'my_podcasts' && p.creator_id === currentUser?.id);
        return matchesSearch && matchesFilter;
    }) || [];
    
    return (
        <div className="max-w-4xl mx-auto p-4">
            <div className="flex flex-col md:flex-row gap-4 mb-6">
                <input
                    type="text"
                    placeholder="Search by topic or creator..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="flex-grow"
                />
                <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2">
                    <option value="upvotes">Most Upvoted</option>
                    <option value="created_at">Newest</option>
                </select>
            </div>
            {loading && !podcasts && <div className="text-center"><Spinner /></div>}
            <div className="space-y-4">
                {filteredPodcasts.map(podcast => (
                    <div key={podcast.id} className="bg-gray-800 rounded-lg shadow-md p-4 flex items-center gap-4">
                        <div className="flex flex-col items-center justify-center w-16">
                            <button onClick={() => handleUpvote(podcast.id)} className={`text-2xl ${myUpvotes.has(podcast.id) ? 'text-blue-500' : 'text-gray-500 hover:text-blue-400'}`}>
                                <i className="fas fa-arrow-up"></i>
                            </button>
                            <span className="font-bold text-lg">{podcast.upvote_count}</span>
                        </div>
                        <div className="flex-grow">
                            <h3 className="text-xl font-bold hover:text-blue-400 cursor-pointer" onClick={() => onSelectPodcast(podcast.id)}>{podcast.topic}</h3>
                            <p className="text-sm text-gray-400">By {podcast.creator_username} &bull; {new Date(podcast.created_at).toLocaleDateString()}</p>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};


// --- MAIN APP COMPONENT ---

function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [activeTab, setActiveTab] = useState('create');
  const [selectedPodcastId, setSelectedPodcastId] = useState(null);
  
  const { data: lockData } = useQuery(room.collection('generation_lock').filter({id: LOCK_ID}));
  const generationLock = lockData?.[0];

  useEffect(() => {
    window.websim.getCurrentUser().then(setCurrentUser);
  }, []);

  const renderContent = () => {
    if (selectedPodcastId) {
        return <PodcastPlayer podcastId={selectedPodcastId} onBack={() => setSelectedPodcastId(null)} />;
    }
    
    switch (activeTab) {
        case 'create':
            return currentUser ? <PodcastGenerator currentUser={currentUser} /> : <Spinner />;
        case 'browse':
            return currentUser ? <PodcastList onSelectPodcast={setSelectedPodcastId} currentUser={currentUser} /> : <Spinner />;
        case 'my_podcasts':
            return currentUser ? <PodcastList onSelectPodcast={setSelectedPodcastId} currentUser={currentUser} filter="my_podcasts"/> : <Spinner />;
        default:
            return <PodcastGenerator currentUser={currentUser} />;
    }
  }

  const isGenerating = generationLock && generationLock.user_id !== currentUser?.id;

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
        <AnimatePresence>
            {isGenerating && <GenerationModal lock={generationLock} />}
        </AnimatePresence>
        
        <header className="bg-gray-800 shadow-md">
            <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <div className="flex items-center justify-between h-16">
                    <div className="flex items-center">
                        <i className="fas fa-podcast text-blue-400 text-2xl mr-3"></i>
                        <span className="font-bold text-xl">AI Podcast Studio</span>
                    </div>
                    {!selectedPodcastId && <div className="flex space-x-4">
                        {['create', 'browse', 'my_podcasts'].map(tab => (
                             <button key={tab} onClick={() => setActiveTab(tab)} className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === tab ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700 hover:text-white'}`}>
                                 {tab.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                             </button>
                        ))}
                    </div>}
                    <div className="flex items-center">
                        {currentUser ? (
                           <>
                             <img src={`https://images.websim.com/avatar/${currentUser.username}`} alt={currentUser.username} className="w-8 h-8 rounded-full mr-2" />
                             <span>{currentUser.username}</span>
                           </>
                        ) : <Spinner />}
                    </div>
                </div>
            </nav>
        </header>

        <main>
            {renderContent()}
        </main>
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<App />);