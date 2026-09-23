#!/bin/sh
python -m http.server &
firefox http://localhost:8000/diagnostic.html &
