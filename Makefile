.PHONY: build run release clean

# Debug build + launch
build:
	swift build

run: build
	open ".build/debug/AgentWidget" 2>/dev/null || swift run

# Release bundle (proper .app with notifications)
release:
	./bundle.sh release
	open ".build/Mission Control.app"

# Development bundle (faster rebuild)
dev:
	./bundle.sh debug
	open ".build/Mission Control.app"

clean:
	swift package clean
	rm -rf .build
