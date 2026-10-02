package topicstate

import (
	"reflect"
	"testing"
)

func TestLayoutRoundTripsAndNormalizes(t *testing.T) {
	root := t.TempDir()
	empty, err := LoadLayout(root)
	if err != nil || len(empty.TagOrder) != 0 || len(empty.TopicOrder) != 0 {
		t.Fatalf("LoadLayout() on a new dir = %+v, %v", empty, err)
	}
	saved, err := SaveLayout(root, Layout{
		TagOrder:   []string{" tag:work ", "tag:home", "tag:work", ""},
		TopicOrder: map[string][]string{"tag:work": {"b", "a", "b", " "}, "pinned": {}, " ": {"x"}},
	})
	if err != nil {
		t.Fatalf("SaveLayout() error = %v", err)
	}
	want := Layout{TagOrder: []string{"tag:work", "tag:home"}, TopicOrder: map[string][]string{"tag:work": {"b", "a"}}}
	if !reflect.DeepEqual(saved, want) {
		t.Fatalf("SaveLayout() = %+v, want %+v", saved, want)
	}
	loaded, err := LoadLayout(root)
	if err != nil || !reflect.DeepEqual(loaded, want) {
		t.Fatalf("LoadLayout() = %+v, %v; want %+v", loaded, err, want)
	}
}

func TestRemoveTopicFromLayout(t *testing.T) {
	root := t.TempDir()
	if _, err := SaveLayout(root, Layout{TopicOrder: map[string][]string{"tag:work": {"a", "b"}, "pinned": {"a"}}}); err != nil {
		t.Fatal(err)
	}
	if err := RemoveTopicFromLayout(root, "a"); err != nil {
		t.Fatalf("RemoveTopicFromLayout() error = %v", err)
	}
	loaded, _ := LoadLayout(root)
	if want := map[string][]string{"tag:work": {"b"}}; !reflect.DeepEqual(loaded.TopicOrder, want) {
		t.Fatalf("topic order = %v, want %v", loaded.TopicOrder, want)
	}
	if err := RemoveTopicFromLayout(t.TempDir(), "a"); err != nil {
		t.Fatalf("RemoveTopicFromLayout() without a layout = %v", err)
	}
}
