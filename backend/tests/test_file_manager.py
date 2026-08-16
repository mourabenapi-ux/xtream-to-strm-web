import unittest
import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.services.file_manager import FileManager

class TestFileManagerNFO(unittest.TestCase):
    def setUp(self):
        self.fm = FileManager("/tmp/test_output")

    def test_generate_movie_nfo_strip_prefix(self):
        # Test cases with prefixes
        test_cases = [
            ("FR - Movie Name", "Movie Name"),
            ("TN - Another Movie", "Another Movie"),
            ("ARA - Third Movie", "Third Movie"),
            ("US - Movie 4", "Movie 4"),
            ("EN - Movie 5", "Movie 5"),
            ("Movie Without Prefix", "Movie Without Prefix"),
            ("FR - ", ""), # Edge case: just prefix
        ]

        for input_name, expected_title in test_cases:
            data = {
                "name": input_name,
                "tmdb": None # Ensure we use the full NFO generation path
            }
            nfo = self.fm.generate_movie_nfo(data)
            self.assertIn(f"<title>{expected_title}</title>", nfo)

    def test_generate_show_nfo_strip_prefix(self):
        # Test cases with prefixes
        test_cases = [
            ("FR - Series Name", "Series Name"),
            ("TN - Another Series", "Another Series"),
            ("ARA - Third Series", "Third Series"),
            ("Series Without Prefix", "Series Without Prefix"),
        ]

        for input_name, expected_title in test_cases:
            data = {
                "name": input_name,
                "tmdb": None # Ensure we use the full NFO generation path
            }
            nfo = self.fm.generate_show_nfo(data)
            self.assertIn(f"<title>{expected_title}</title>", nfo)

    def test_generate_movie_nfo_with_tmdb(self):
        # Should ignore name and just use TMDB ID
        data = {
            "name": "FR - Movie Name",
            "tmdb": "12345"
        }
        nfo = self.fm.generate_movie_nfo(data)
        self.assertIn("<tmdbid>12345</tmdbid>", nfo)
        self.assertNotIn("<title>", nfo)

    def test_generate_movie_nfo_custom_regex(self):
        # Test with custom regex
        data = {
            "name": "TEST - Custom Movie",
            "tmdb": None
        }
        nfo = self.fm.generate_movie_nfo(data, prefix_regex=r'^TEST - ')
        self.assertIn("<title>Custom Movie</title>", nfo)

if __name__ == '__main__':
    unittest.main()
