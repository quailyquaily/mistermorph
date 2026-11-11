package agent

import "strings"

// The worker name sets: which pool new subagent and coder workers are named from. A task takes
// the set when it starts and records it with every worker (WorkerMetadata.NameSet) and in its
// approval pause, so changing the preference never renames a worker already named, nor mixes
// sets within a task.
const (
	WorkerNameSetScientists = "scientists"
	WorkerNameSetMusicians  = "musicians"
	WorkerNameSetArtists    = "artists"
	// DefaultWorkerNameSet is the set workers were named from before sets existed.
	DefaultWorkerNameSet = WorkerNameSetScientists
)

// WorkerNameSets lists the sets in the order the Console offers them.
func WorkerNameSets() []string {
	return []string{WorkerNameSetScientists, WorkerNameSetMusicians, WorkerNameSetArtists}
}

// NormalizeWorkerNameSet returns the set named by value, or the default for a missing or
// unknown one.
func NormalizeWorkerNameSet(value string) string {
	set := strings.ToLower(strings.TrimSpace(value))
	if _, ok := workerNamePools[set]; ok {
		return set
	}
	return DefaultWorkerNameSet
}

// The English name pools. The Console keeps the same lists, and the same people in the same
// order for each of its other languages, in web/console-nsh/lib/core/worker-identity.js. A name
// index keeps its meaning across builds, so every list keeps its size and order: append a new
// set rather than editing one. All pools have the same size, and no name is in two pools (nor
// in the Console's legacy pool of ordinary first names, which workers carried before the
// scientists), so a recorded name always tells which pool it came from.
var (
	// workerNames is the scientist pool, the only one before name sets existed.
	workerNames = [...]string{
		"Einstein", "Curie", "Newton", "Darwin", "Noether", "Galileo", "Turing", "Lovelace",
		"Faraday", "Maxwell", "Bohr", "Planck", "Kepler", "Pasteur", "Mendel", "Hopper",
		"Franklin", "Feynman", "Hubble", "Tesla", "Euler", "Gauss", "Lavoisier", "Mendeleev",
		"Hawking", "Meitner", "Fermi", "Dirac", "Copernicus", "Ramanujan", "Goodall", "Archimedes",
	}
	workerMusicianNames = [...]string{
		"Bach", "Mozart", "Beethoven", "Chopin", "Vivaldi", "Handel", "Haydn", "Schubert",
		"Brahms", "Tchaikovsky", "Verdi", "Puccini", "Debussy", "Ravel", "Liszt", "Mahler",
		"Dvořák", "Grieg", "Sibelius", "Stravinsky", "Gershwin", "Ellington", "Armstrong", "Coltrane",
		"Fitzgerald", "Piaf", "Schumann", "Rachmaninoff", "Satie", "Hildegard", "Boulanger", "Sakamoto",
	}
	workerArtistNames = [...]string{
		"Leonardo", "Michelangelo", "Raphael", "Rembrandt", "Vermeer", "Van Gogh", "Monet", "Renoir",
		"Cézanne", "Degas", "Picasso", "Matisse", "Kahlo", "Hokusai", "Hiroshige", "Klimt",
		"Dürer", "Botticelli", "Caravaggio", "Goya", "Turner", "O'Keeffe", "Kandinsky", "Mondrian",
		"Magritte", "Dalí", "Miró", "Chagall", "Warhol", "Gentileschi", "Gauguin", "Qi Baishi",
	}
)

var workerNamePools = map[string][]string{
	WorkerNameSetScientists: workerNames[:],
	WorkerNameSetMusicians:  workerMusicianNames[:],
	WorkerNameSetArtists:    workerArtistNames[:],
}

// workerNamePool is the English pool of a normalized set.
func workerNamePool(set string) []string {
	return workerNamePools[NormalizeWorkerNameSet(set)]
}
